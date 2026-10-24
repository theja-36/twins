import { describe, expect, it } from "vitest";
import { ALLOWED_METHODS, BotApi, TelegramApiError } from "../../../services/approval-bot/src/telegramApi";

const TOKEN = "123456:AAFakeTokenForTestsOnly_0123456789abcdef";
const BASE = "http://127.0.0.1:9";
type Call = { url: string; init: RequestInit };
function api(reply: (c: Call) => Response | Promise<Response> | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    const r = await reply(c);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { calls, api: new BotApi(TOKEN, BASE, fetchImpl, 200) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("BotApi", () => {
  it("posts JSON to /bot<token>/<method>, refusing redirects, with a timeout signal", async () => {
    const { api: a, calls } = api(() => json({ ok: true, result: { message_id: 7 } }));
    expect(await a.sendMessage(5, "hi", [{ text: "A", callback_data: "x" }])).toBe(7);
    expect(calls[0]!.url).toBe(`${BASE}/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ chat_id: 5, text: "hi", reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "x" }]] } });
  });
  it("only the five allowed methods exist", () => {
    expect([...ALLOWED_METHODS].sort()).toEqual(["answerCallbackQuery", "editMessageText", "getMe", "getUpdates", "sendMessage"]);
    const proto = Object.getOwnPropertyNames(BotApi.prototype).filter((n) => n !== "constructor" && n !== "call");
    expect(proto.sort()).toEqual(["answerCallbackQuery", "editMessageText", "getMe", "getUpdates", "sendMessage"]);
  });
  it("editing a card omits reply_markup so the buttons disappear", async () => {
    const { api: a, calls } = api(() => json({ ok: true, result: true }));
    await a.editMessageText(5, 9, "done");
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty("reply_markup");
  });
  it("errors carry only method, numeric code and retry_after - never the URL, token, body or cause", async () => {
    const cases: Array<[Response | Error, number, number | undefined]> = [
      [json({ ok: false, error_code: 429, description: `secret ${TOKEN}`, parameters: { retry_after: 33 } }, 429), 429, 33],
      [json({ ok: false, error_code: 401, description: "Unauthorized" }, 401), 401, undefined],
      [new TypeError(`fetch failed ${BASE}/bot${TOKEN}/getMe`), 0, undefined],
      [new Response("<html>not json</html>", { status: 502 }), 502, undefined],
    ];
    for (const [reply, code, retry] of cases) {
      const { api: a } = api(() => reply);
      const e = (await a.getMe().catch((x: unknown) => x)) as TelegramApiError;
      expect(e).toBeInstanceOf(TelegramApiError);
      expect(e).toMatchObject({ method: "getMe", code, retryAfter: retry });
      expect(`${e.message}${e.stack ?? ""}${JSON.stringify(e)}`).not.toContain(TOKEN);
      expect(e.cause).toBeUndefined();
    }
  });
  it("a hung server hits the timeout", async () => {
    const { api: a } = api(({ init }) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))) as unknown as Response);
    await expect(a.getMe()).rejects.toMatchObject({ method: "getMe", code: 0 });
  });
  it("getMe requires a bot identity; getUpdates asks only for callback queries and messages", async () => {
    const bad = api(() => json({ ok: true, result: { id: 1, is_bot: false } }));
    await expect(bad.api.getMe()).rejects.toMatchObject({ code: 0 });
    const { api: a, calls } = api(() => json({ ok: true, result: [{ update_id: 3 }] }));
    expect(await a.getUpdates(3, 30)).toEqual([{ update_id: 3 }]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ offset: 3, timeout: 30, allowed_updates: ["callback_query", "message"] });
  });
});

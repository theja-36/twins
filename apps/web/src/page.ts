/** Static assets of the read-only options-result viewer. No secret is embedded; the token is typed by the owner. */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TWINS options result viewer</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header><h1>TWINS options result viewer</h1><p class="sub">Read-only. Shows the STORED result only - nothing is reparsed, reassessed or ordered.</p></header>
<main>
<form id="f" autocomplete="off">
  <label>Internal message id (telegram_messages.id)<input id="mid" name="mid" required spellcheck="false" autocomplete="off" placeholder="00000000-0000-0000-0000-000000000000"></label>
  <label>Parser version (optional filter)<input id="pv" name="pv" spellcheck="false" autocomplete="off" placeholder="leave empty to list every version"></label>
  <label>API bearer token (kept in this page only, never stored or put in a URL)<input id="tok" name="tok" type="password" required autocomplete="off" spellcheck="false"></label>
  <button type="submit">Fetch stored result</button>
</form>
<div id="status" role="status" aria-live="polite"></div>
<div id="out"></div>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

export const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#555;--line:#c8c8c8;--warn:#8a5a00;--bad:#9b1c1c;--card:#f6f6f6}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#aaa;--line:#444;--warn:#f0b44c;--bad:#ff8a8a;--card:#202020}}
body{margin:0;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header,main{max-width:960px;margin:0 auto;padding:0 16px}
h1{font-size:1.3rem;margin:16px 0 0}.sub{color:var(--mut);margin:4px 0 16px}
form{display:grid;gap:10px;margin-bottom:12px}label{display:grid;gap:4px;font-weight:600}
input{padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;font-weight:400}
button{padding:9px 14px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);font:inherit;cursor:pointer;width:max-content}
#status{min-height:1.4em;margin-bottom:8px}#status.error{color:var(--bad)}
.card{border:2px solid var(--line);border-radius:8px;margin:14px 0;background:var(--card)}
.card>h2{margin:0;padding:10px 12px;border-bottom:1px solid var(--line);font-size:1.05rem}
.banner{padding:8px 12px;font-weight:700;border-bottom:1px solid var(--line)}
.warn{padding:6px 12px;color:var(--warn);font-weight:600}
section{padding:8px 12px;border-bottom:1px solid var(--line)}section:last-child{border-bottom:0}
section h3{margin:4px 0 6px;font-size:.95rem;color:var(--mut)}
dl{display:grid;grid-template-columns:minmax(150px,max-content) 1fr;gap:2px 12px;margin:0}dt{color:var(--mut)}dd{margin:0;overflow-wrap:anywhere}
ul{margin:4px 0 0;padding-left:18px}code{font-size:.9em}
`;

// Rendering uses textContent only (message-derived strings are never interpreted as HTML) and keeps the token in memory.
export const PAGE_JS = `(function(){
  var form=document.getElementById("f"),status=document.getElementById("status"),out=document.getElementById("out");
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
  function setStatus(msg,isError){status.textContent=msg;status.className=isError?"error":"";}
  function render(view){
    out.textContent="";
    var head=el("p","",view.versionCount+" stored version(s) for message "+view.messageId+(view.selectedParserVersion?" (filtered to "+view.selectedParserVersion+")":"")+". "+view.notice);
    out.appendChild(head);
    view.versions.forEach(function(v){
      var card=el("div","card");
      card.appendChild(el("h2","","Parser version: "+v.parserVersion+" - "+v.kindLabel));
      card.appendChild(el("div","banner",v.banner+" | approvalPossible=false | recorded "+v.recordedAt));
      v.warnings.forEach(function(w){card.appendChild(el("div","warn",w));});
      v.sections.forEach(function(s){
        var sec=el("section");sec.appendChild(el("h3","",s.title));
        var dl=el("dl");s.rows.forEach(function(r){dl.appendChild(el("dt","",r.label));dl.appendChild(el("dd","",r.value));});
        sec.appendChild(dl);card.appendChild(sec);
      });
      var rs=el("section");rs.appendChild(el("h3","","Stored reasons"));
      var ul=el("ul");v.reasons.forEach(function(r){var li=el("li");li.appendChild(el("code","",r.code));li.appendChild(document.createTextNode(" ["+r.severity+"]: "+r.description));ul.appendChild(li);});
      rs.appendChild(ul);card.appendChild(rs);
      out.appendChild(card);
    });
  }
  form.addEventListener("submit",function(ev){
    ev.preventDefault();out.textContent="";setStatus("Fetching...",false);
    var id=document.getElementById("mid").value.trim(),pv=document.getElementById("pv").value.trim(),tok=document.getElementById("tok").value;
    var url="/view/options-claims/"+encodeURIComponent(id)+(pv?"?parserVersion="+encodeURIComponent(pv):"");
    fetch(url,{method:"GET",headers:{Authorization:"Bearer "+tok},cache:"no-store",credentials:"omit"}).then(function(r){return r.json().then(function(b){return{status:r.status,body:b};});}).then(function(res){
      if(res.status===200){setStatus("Stored result loaded (read-only).",false);render(res.body);}
      else{setStatus((res.body&&res.body.error&&res.body.error.message)||"Request failed.",true);}
    }).catch(function(){setStatus("The viewer itself could not be reached.",true);});
  });
})();
`;

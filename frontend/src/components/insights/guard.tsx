"use client";
import type { ReactNode } from "react";
/** Marks the boundary where a section mounts (and therefore where its single analytics request starts). Kept as one place so a test can assert no section is mounted for an unauthorised role. */
export function SectionMount({ children }: { children: ReactNode }) { return <div data-testid="insights-body">{children}</div>; }

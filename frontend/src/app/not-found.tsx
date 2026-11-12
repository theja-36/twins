import Link from "next/link";
export default function NotFound() {
  return <main className="login" id="main"><div className="panel"><h1>Not found</h1><p className="small muted">This page does not exist, or is not available to you.</p><p><Link className="btn" href="/">Back to start</Link></p></div></main>;
}

/* Mockup-only behaviour: theme toggle (remembered per browser, optional ?theme=light|dark) and accessible tabs. The production app implements these as typed React components. */
(function(){
  var root=document.documentElement, q=new URLSearchParams(location.search).get("theme");
  try{ var saved=localStorage.getItem("twins-mock-theme"); if(q==="light"||q==="dark") root.dataset.theme=q; else if(saved==="light"||saved==="dark") root.dataset.theme=saved; }catch(e){ if(q==="light"||q==="dark") root.dataset.theme=q; }
  document.addEventListener("click",function(ev){
    var t=ev.target.closest("#theme"); if(t){ var cur=root.dataset.theme||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"); var next=cur==="light"?"dark":"light"; root.dataset.theme=next; try{localStorage.setItem("twins-mock-theme",next)}catch(e){} return; }
    var tab=ev.target.closest('[role="tab"]'); if(tab) select(tab);
  });
  document.addEventListener("keydown",function(ev){
    var tab=ev.target.closest('[role="tab"]'); if(!tab||(ev.key!=="ArrowRight"&&ev.key!=="ArrowLeft"))return;
    var tabs=[].slice.call(tab.parentElement.querySelectorAll('[role="tab"]')), i=tabs.indexOf(tab), n=tabs[(i+(ev.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length]; n.focus(); select(n); ev.preventDefault();
  });
  function select(tab){
    var list=tab.parentElement; [].forEach.call(list.querySelectorAll('[role="tab"]'),function(t){var on=t===tab; t.setAttribute("aria-selected",on); t.tabIndex=on?0:-1; var p=document.getElementById(t.getAttribute("aria-controls")); if(p) p.hidden=!on;});
  }
})();

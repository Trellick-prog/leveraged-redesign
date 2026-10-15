document.addEventListener('DOMContentLoaded',function(){
  var h=document.querySelector('.site-header'),b=h&&h.querySelector('.sh-menu');if(!b)return;
  b.addEventListener('click',function(){var o=h.classList.toggle('open');b.setAttribute('aria-expanded',o)});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&h.classList.contains('open')){h.classList.remove('open');b.setAttribute('aria-expanded','false');b.focus()}});
});

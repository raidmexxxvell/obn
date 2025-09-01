// Stream tab setup + landscape handling
(function(){
  function setup(mdPane, subtabs, match){
    let streamPane=document.getElementById('md-pane-stream');
    if(streamPane){ return streamPane; }
    streamPane=document.createElement('div');
    streamPane.id='md-pane-stream';
    streamPane.className='md-pane';
    streamPane.style.display='none';
    mdPane.querySelector('.modal-body')?.appendChild(streamPane);
    // Первичная инициализация через Streams модуль (лениво)
    try {
      if(window.Streams?.setupMatchStreamDirect){
        window.Streams.setupMatchStreamDirect(streamPane, match);
      } else if(window.Streams?.setupMatchStream){
        window.Streams.setupMatchStream(mdPane, subtabs, match);
      }
    } catch(_){ }
    return streamPane;
  }
  function activate(streamPane, match){
    if(!streamPane) return;
    streamPane.style.display='';
    try { if(window.Streams?.onStreamTabActivated) window.Streams.onStreamTabActivated(streamPane, match); } catch(_){ }
    try { document.body.classList.add('allow-landscape'); } catch(_){ }
  }
  function deactivate(streamPane){
    try {
      if(streamPane){ streamPane.style.display='none'; streamPane.classList.remove('fs-mode'); }
      document.body.classList.remove('allow-landscape');
    } catch(_){ }
  }
  function cleanup(mdPane){
    try {
      const sp=mdPane.querySelector('#md-pane-stream');
      if(sp){ sp.classList.remove('fs-mode'); sp.style.display='none'; }
    } catch(_){ }
    deactivate();
  }
  window.MatchStream={ setup, activate, deactivate, cleanup };
})();

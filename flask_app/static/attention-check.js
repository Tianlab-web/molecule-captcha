/* All toolbar candidates receive a transparent atlas tile; only one contains an arrow. */
(function () {
  'use strict';
  var claimed=false;
  var catalog=['bonds','chain','charge-plus','charge-minus'].map(function(key){return {key:key,side:'left',selector:'[data-testid="'+key+'"]'};});
  ['H','C','N','O','S','P','F','Cl','Br','I','B','Si','Se','Li','Na','Mg','Fe','Zn'].forEach(function(atom){
    catalog.push({key:'atom:'+atom,side:'right',selector:'[data-kqa-native-atom="'+atom+'"],[data-kqa-atom="'+atom+'"]'});
  });
  for(var i=0;i<8;i++)catalog.push({key:'template-'+i,side:'down',selector:'[data-testid="template-'+i+'"]'});
  catalog.forEach(function(item,index){item.index=index;item.x=item.side==='left'?4:item.side==='right'?324:Math.min(8+36*(index-22),164);item.y=item.side==='down'?96:48;});
  function controller(){
    var current=null, suppressed=null, suppressUntil=0;
    function clean(run){clearTimeout(run.timer);cancelAnimationFrame(run.animation);if(run.layer)run.layer.remove();if(run.waitNotice)run.waitNotice.remove();}
    function settle(run,status){if(run.settled)return;run.settled=true;run.status=status;clean(run);run.resolve(status);}
    function stop(){if(current)settle(current,'cancelled');current=null;}
    async function send(run,action,extra){
      var aborter=new AbortController(),timer=setTimeout(function(){aborter.abort();},4000);
      try{
        var response=await fetch(run.endpoint,{method:'POST',credentials:'same-origin',signal:aborter.signal,
          headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:run.token,action:action},extra||{}))});
        var result=await response.json();if(!response.ok||!result.ok)throw new Error(result.message||'Click verification failed');return result;
      }finally{clearTimeout(timer);}
    }
    function english(){return new URLSearchParams(location.search).get('lang')!=='zh';}
    async function show(run,result,elapsed){
      if(result.version!==3||result.width!==360||result.height!==catalog.length*128||typeof result.frameId!=='string'||
         typeof result.image!=='string'||!result.image.startsWith('data:image/png;base64,'))throw new Error('Unsupported arrow challenge');
      run.challenge=result;run.deadline=performance.now()+Math.max(0,result.remainingMs-elapsed);
      var decoded=new Image();decoded.src=result.image;await decoded.decode();
      if(run.settled||current!==run)return;
      if(performance.now()>=run.deadline){settle(run,'failed');return;}
      var layer=document.createElement('div');layer.id='attention-layer';layer.setAttribute('aria-label','请在5秒内点击箭头指向的按钮');
      layer.setAttribute('role','img');
      run.tiles=catalog.map(function(item){
        var tile=document.createElement('div');tile.className='attention-arrow-tile';
        tile.style.backgroundImage='url("'+result.image+'")';tile.style.backgroundPosition='0 -'+(item.index*128)+'px';
        layer.appendChild(tile);return {item:item,node:tile};
      });
      run.layer=layer;document.body.appendChild(layer);run.status='shown';
      function tick(){
        if(run.settled)return;
        run.tiles.forEach(function(tile){
          var button=document.querySelector(tile.item.selector),r=button&&button.getBoundingClientRect();
          if(!r||r.width<=0||r.height<=0){tile.node.style.display='none';return;}
          tile.node.style.display='block';
          // Anchor to the current real button on every frame, including sidebar shuffles/resizes.
          var left=tile.item.side==='left'?r.right-36:tile.item.side==='right'?r.left-324:r.left+r.width/2-tile.item.x-16;
          var top=tile.item.side==='down'?r.top-96:r.top+r.height/2-64;
          tile.node.style.left=left+'px';tile.node.style.top=top+'px';
        });
        run.animation=requestAnimationFrame(tick);
      }
      tick();
      run.timer=setTimeout(async function(){
        if(run.releasing)return;
        try{var latest=await send(run,'poll');settle(run,latest.status==='passed'?'passed':'failed');}catch(_){settle(run,'failed');}
      },Math.max(0,run.deadline-performance.now())+50);
    }
    async function poll(run){
      if(run.settled||current!==run)return;
      try{
        var began=performance.now(),result=await send(run,'poll');if(run.settled||current!==run)return;
        if(result.status==='scheduled')run.timer=setTimeout(function(){poll(run);},Math.max(25,result.retryAfterMs));
        else if(result.status==='shown')await show(run,result,performance.now()-began);
        else settle(run,result.status==='passed'?'passed':'failed');
      }catch(_){settle(run,'failed');}
    }
    function start(options){
      stop();var run={endpoint:options.endpoint+'/'+encodeURIComponent(options.sessionId)+'/attention',token:options.token,
        record:options.record,status:'scheduled',settled:false};
      run.done=new Promise(function(resolve){run.resolve=resolve;});current=run;poll(run);
    }
    function stopEvent(event){event.preventDefault();event.stopImmediatePropagation();}
    function candidate(target){
      if(!target||!target.closest)return null;
      for(var item of catalog){var button=target.closest(item.selector);if(button)return {item:item,button:button};}
      return null;
    }
    function eventData(run,event){
      var r=run.pressedButton.getBoundingClientRect(),item=run.pressedItem;
      return {challengeId:run.challenge.challengeId,frameId:run.challenge.frameId,
        x:Math.round((item.x+(event.clientX-r.left)*32/r.width)*100)/100,
        y:Math.round((item.index*128+item.y+(event.clientY-r.top)*32/r.height)*100)/100,
        pointerId:event.pointerId,pointerType:event.pointerType,button:0};
    }
    window.addEventListener('pointerdown',function(event){
      var run=current,hit=candidate(event.target);if(!run||run.settled||!run.layer||!hit)return;
      stopEvent(event);
      if(!event.isTrusted||event.button!==0||run.status!=='shown'||document.visibilityState!=='visible'||performance.now()>run.deadline)return;
      run.pointerId=event.pointerId;run.status='pressed';run.pressedItem=hit.item;run.pressedButton=hit.button;
      suppressed=hit.button;suppressUntil=performance.now()+2500;
      var entry=run.record('attention_down',eventData(run,event));
      run.press=send(run,'down',{nonce:run.challenge.nonce,event:entry});run.press.catch(function(){settle(run,'failed');});
    },true);
    window.addEventListener('pointerup',function(event){
      var run=current;
      if(suppressed&&performance.now()<suppressUntil&&suppressed.contains(event.target))stopEvent(event);
      if(!run||run.settled||!run.layer||run.status!=='pressed')return;
      stopEvent(event);
      if(!event.isTrusted||event.button!==0||event.pointerId!==run.pointerId)return;
      var data=eventData(run,event);
      if(data.x<0||data.y<0||data.x>run.challenge.width||data.y>run.challenge.height||performance.now()>run.deadline){settle(run,'failed');return;}
      var entry=run.record('attention_up',data);run.releasing=true;
      run.press.then(function(result){return send(run,'up',{nonce:result.pressNonce,event:entry});})
        .then(function(result){settle(run,result.status==='passed'?'passed':'failed');},function(){settle(run,'failed');});
    },true);
    ['mousedown','mouseup','click','dblclick','contextmenu','keydown','dragstart'].forEach(function(kind){
      window.addEventListener(kind,function(event){
        var run=current;
        if((run&&!run.settled&&run.layer&&candidate(event.target))||
           (suppressed&&performance.now()<suppressUntil&&suppressed.contains(event.target))){stopEvent(event);if(kind==='click')suppressed=null;}
      },true);
    });
    window.addEventListener('pointercancel',function(event){if(current&&current.status==='pressed'&&event.pointerId===current.pointerId)settle(current,'failed');},true);
    return Object.freeze({start:start,stop:stop,wait:function(){
      if(current&&!current.settled&&!current.waitNotice){
        var notice=document.createElement('div');notice.id='attention-wait';notice.setAttribute('role','status');
        notice.textContent=english()?'Waiting for the timed click check before analysis…':'等待限时点击验证，完成后自动分析…';document.body.appendChild(notice);current.waitNotice=notice;
      }
      return current?current.done:Promise.resolve('missing');
    }});
  }
  window.ketcherAttentionCheck=Object.freeze({claim:function(){if(claimed)return null;claimed=true;return controller();}});
}());

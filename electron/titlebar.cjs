function installTitlebar(window,handle){
 window.removeMenu?.();
 const alive=()=>!window.isDestroyed();
 const state=()=>({maximized:alive()&&window.isMaximized()});
 handle('window-state',state);
 handle('window-minimize',()=>{if(alive())window.minimize()});
 handle('window-toggle-maximize',()=>{if(alive()){if(window.isMaximized())window.unmaximize();else window.maximize()}return state()});
 handle('window-close',()=>{if(alive())window.close()});
 const changed=()=>{if(alive()&&!window.webContents.isDestroyed())window.webContents.send('window-state-changed',state())};
 window.on('maximize',changed);window.on('unmaximize',changed);
 window.once('closed',()=>{window.removeListener('maximize',changed);window.removeListener('unmaximize',changed)});
}
module.exports={installTitlebar};

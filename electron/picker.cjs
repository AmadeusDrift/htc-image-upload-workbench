const {spawn}=require('node:child_process');
const path=require('node:path');

function pickPaths(win,mode,packaged,initialDirectory) {
  const exe=packaged ? path.join(process.resourcesPath,'app.asar.unpacked','electron','native-picker','ShellPicker.exe')
    : path.join(__dirname,'native-picker','ShellPicker.exe');
  const hwnd=win.getNativeWindowHandle();
  const owner=(hwnd.length===8 ? hwnd.readBigUInt64LE() : BigInt(hwnd.readUInt32LE())).toString();
  return new Promise((resolve,reject)=>{
    const args=initialDirectory ? [mode,owner,initialDirectory] : [mode,owner];
    const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const chunks=[],errors=[];
    const close=()=>child.kill();
    win.once('closed',close);
    child.stdout.on('data',data=>chunks.push(data));
    child.stderr.on('data',data=>errors.push(data));
    child.on('error',reject);
    child.on('close',code=>{
      win.removeListener('closed',close);
      if(code!==0){reject(Error(Buffer.concat(errors).toString('utf8').trim()||'Windows 文件视图未能打开'));return}
      try{
        const paths=JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''));
        if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw Error('文件视图返回了无效路径');
        resolve(paths);
      }catch(error){reject(error)}
    });
  });
}
module.exports={pickPaths};

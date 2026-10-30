import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url);
const {installTitlebar}=require('../electron/titlebar.cjs');
function windowMock(){const win:any=new EventEmitter();let maximized=false;win.minimize=vi.fn();win.close=vi.fn();win.isMaximized=()=>maximized;win.isDestroyed=()=>false;win.webContents={isDestroyed:()=>false,send:vi.fn()};win.maximize=vi.fn(()=>{maximized=true;win.emit('maximize')});win.unmaximize=vi.fn(()=>{maximized=false;win.emit('unmaximize')});return win}
describe('custom desktop titlebar',()=>{
 it('removes the default native menu from the custom framed window',()=>{const win=windowMock();win.removeMenu=vi.fn();installTitlebar(win,()=>{});expect(win.removeMenu).toHaveBeenCalledOnce()});
 it('only registers named controls through the trusted handle wrapper',()=>{const win=windowMock(),handlers=new Map();const trusted=vi.fn((name,fn)=>handlers.set(name,fn));installTitlebar(win,trusted);expect([...handlers.keys()].sort()).toEqual(['window-close','window-minimize','window-state','window-toggle-maximize']);expect(trusted).toHaveBeenCalledTimes(4)});
 it('minimizes, toggles maximize/restore, and closes through the existing close event path',()=>{const win=windowMock(),handlers=new Map();installTitlebar(win,(name,fn)=>handlers.set(name,fn));expect(handlers.get('window-state')()).toEqual({maximized:false});handlers.get('window-minimize')();expect(win.minimize).toHaveBeenCalledOnce();handlers.get('window-toggle-maximize')();expect(win.maximize).toHaveBeenCalledOnce();expect(handlers.get('window-state')()).toEqual({maximized:true});handlers.get('window-toggle-maximize')();expect(win.unmaximize).toHaveBeenCalledOnce();handlers.get('window-close')();expect(win.close).toHaveBeenCalledOnce()});
 it('publishes maximize changes and stops sending when the window closes',()=>{const win=windowMock();installTitlebar(win,()=>{});win.maximize();win.unmaximize();expect(win.webContents.send.mock.calls).toEqual([['window-state-changed',{maximized:true}],['window-state-changed',{maximized:false}]]);win.emit('closed');win.emit('maximize');expect(win.webContents.send).toHaveBeenCalledTimes(2)});
 it('does not invoke controls after the native window is destroyed',()=>{const win=windowMock(),handlers=new Map();installTitlebar(win,(name,fn)=>handlers.set(name,fn));win.isDestroyed=()=>true;handlers.get('window-minimize')();handlers.get('window-toggle-maximize')();handlers.get('window-close')();expect(win.minimize).not.toHaveBeenCalled();expect(win.maximize).not.toHaveBeenCalled();expect(win.close).not.toHaveBeenCalled()});
});
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import TitleBar from './TitleBar';
describe('desktop titlebar rendering',()=>{
 it('renders no header for ordinary browser or server rendering',()=>{vi.stubGlobal('window',{});try{expect(renderToStaticMarkup(React.createElement(TitleBar))).toBe('')}finally{vi.unstubAllGlobals()}});
 it('renders the product name and accessible custom controls only for desktop',()=>{vi.stubGlobal('window',{desktop:{}});try{const html=renderToStaticMarkup(React.createElement(TitleBar));expect(html).toContain('云图工作台');expect(html).toContain('aria-label="最小化"');expect(html).toContain('aria-label="最大化"');expect(html).toContain('aria-label="关闭窗口"');expect(html).toContain('desktop-titlebar-drag')}finally{vi.unstubAllGlobals()}});
});

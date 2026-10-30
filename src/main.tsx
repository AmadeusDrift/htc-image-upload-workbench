import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import TitleBar from './TitleBar';
import './styles.css';
document.documentElement.classList.toggle('desktop-shell',Boolean(window.desktop));
createRoot(document.getElementById('root')!).render(<><TitleBar/><App/></>);



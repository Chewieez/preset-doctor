import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { UnsupportedBrowser } from './components/web/UnsupportedBrowser';
import './styles.css';

/** 'unsupported': the web version in a browser without folder access (Firefox, Safari, ...). */
export type MountView = 'app' | 'unsupported';

export function mount(el: HTMLElement, view: MountView = 'app'): void {
  createRoot(el).render(
    <StrictMode>{view === 'app' ? <App /> : <UnsupportedBrowser />}</StrictMode>,
  );
}

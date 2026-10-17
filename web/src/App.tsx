import { useEffect, useState } from 'react';
import { useStore, set, boot } from './store';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { ProfilePanel } from './components/ProfilePanel';
import { TraceDrawer } from './components/TraceDrawer';
import { ConnectModal } from './components/ConnectModal';
import { GraphView } from './components/GraphView';
import { ActivityView } from './components/ActivityView';
import { EntityDrawer, FileViewer, ExchangeViewer, NewDotModal } from './components/Overlays';
import { Mascot } from './components/Mascot';
import { Avatar } from './components/Avatar';
import { Icon } from './components/icons';
import { PairModal } from './components/PairModal';

export function App() {
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const view = useStore((s) => s.view);
  const rightOpen = useStore((s) => s.rightOpen);
  const mobileList = useStore((s) => s.mobileList);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return (localStorage.getItem('zivbot.theme') as 'dark' | 'light') || 'dark'; } catch { return 'dark'; }
  });
  useEffect(() => { void boot(); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('zivbot.theme', theme); } catch { /* */ }
  }, [theme]);

  if (!ready) {
    return (
      <div className="splash">
        <Avatar avatar="ziv" size={64} busy />
        <div>{error ? `Can't reach ZivBot (${error}). Is FalkorDB running? Retrying…` : 'Waking up Ziv…'}</div>
      </div>
    );
  }
  return (
    <div className={`app ${rightOpen && view === 'chat' ? 'with-right' : ''} ${(window as any).zivbotDesktop ? `desktop ${(window as any).zivbotDesktop.platform}` : ''} ${mobileList ? 'm-list' : ''}`}>
      <Sidebar />
      <main className="main">
        {view !== 'chat' && <button className="mobile-home icon-btn round" onClick={() => set({ view: 'chat', mobileList: true })} aria-label="Back to chats"><Icon.chevron size={16} className="flip" /></button>}
        <div className="top-tools">
          <button className="icon-btn round" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Theme">{theme === 'dark' ? <Icon.sun size={16} /> : <Icon.moon size={16} />}</button>
          {view === 'chat' && <button className="icon-btn round" onClick={() => set({ rightOpen: !rightOpen })} title="Profile panel"><Icon.panel size={16} /></button>}
        </div>
        {view === 'chat' && <Chat />}
        {view === 'graph' && <GraphView />}
        {view === 'activity' && <ActivityView />}
      </main>
      {rightOpen && view === 'chat' && <ProfilePanel />}
      {view !== 'graph' && <Mascot />}
      <TraceDrawer />
      <EntityDrawer />
      <ExchangeViewer />
      <FileViewer />
      <ConnectModal />
      <NewDotModal />
      <PairModal />
    </div>
  );
}

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, userId, viaRelay, leaveRelay } from '../api';
import { useStore, toast } from '../store';
import { Icon } from './icons';

/**
 * Pair a phone. Same Wi-Fi: a QR for this computer's LAN address. Anywhere: a QR whose
 * fragment carries an encrypted relay channel to this computer (Supabase Realtime, ciphertext
 * only), opened in the ZivBot app or any phone browser — the computer just has to stay on.
 */
export function PairModal() {
  const hosted = useStore((s) => !!s.hosted);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'anywhere' | 'lan'>('anywhere');
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ on: boolean; phones: number } | null>(null);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener('zivbot:pair', on);
    return () => window.removeEventListener('zivbot:pair', on);
  }, []);
  useEffect(() => {
    if (!open || viaRelay()) return;
    void (async () => {
      setQr(''); setUrl('');
      if (mode === 'lan') {
        const desk = (window as any).zivbotDesktop;
        const base = desk ? await desk.lanUrl() : location.origin;
        const u = `${base}/?pair=${userId}`;
        setUrl(u);
        setQr(await QRCode.toDataURL(u, { margin: 1, width: 240, color: { dark: '#141414', light: '#ffffff' } }));
      } else if (!hosted) {
        setBusy(true);
        try {
          const r = await api.relayEnable();
          setUrl(r.link);
          setQr(await QRCode.toDataURL(r.link, { margin: 1, width: 260, errorCorrectionLevel: 'L', color: { dark: '#141414', light: '#ffffff' } }));
          setStatus(await api.relayStatus());
        } catch (e: any) { toast(e.message); } finally { setBusy(false); }
      }
    })();
  }, [open, mode, hosted]);
  useEffect(() => {
    if (!open || mode !== 'anywhere' || hosted || viaRelay()) return;
    const t = setInterval(() => void api.relayStatus().then(setStatus).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [open, mode, hosted]);
  if (!open) return null;
  const phone = !!(window as any).ReactNativeWebView || viaRelay();
  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal pair-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2><Icon.phone size={18} /> {phone ? 'This phone' : 'Pair your phone'}</h2><button aria-label="Close" className="icon-btn" onClick={() => setOpen(false)}><Icon.close size={18} /></button></div>
        <div className="modal-body pair-body">
          {phone ? (
            <>
              <div className="muted">{viaRelay() ? 'Connected to your computer from anywhere, through an end-to-end encrypted relay.' : 'Connected to your computer over Wi-Fi.'}</div>
              <button className="btn ghost sm" onClick={() => { leaveRelay(); (window as any).ReactNativeWebView?.postMessage(JSON.stringify({ type: 'unpair' })); location.reload(); }}>Disconnect this phone</button>
            </>
          ) : (
            <>
              <div className="seg pair-seg">
                <button className={mode === 'anywhere' ? 'on' : ''} onClick={() => setMode('anywhere')}>Anywhere</button>
                <button className={mode === 'lan' ? 'on' : ''} onClick={() => setMode('lan')}>Same Wi-Fi</button>
              </div>
              {mode === 'anywhere' && hosted ? (
                <div className="muted">Anywhere connects your phone to <b>your own computer</b>. Turn it on from the ZivBot desktop app.</div>
              ) : (
                <>
                  {busy && <span className="spinner" />}
                  {qr && <img className="pair-qr" src={qr} width={240} height={240} alt="Pairing QR code" />}
                  <div className="muted">
                    {mode === 'anywhere'
                      ? <>Scan with your phone's camera or the ZivBot app. It reaches the Zivs on <b>this computer</b> from any network — through an end-to-end encrypted Supabase channel that only ever carries ciphertext. Keep this computer on.</>
                      : <>Open the ZivBot app on Android and scan this. Your phone talks to the Zivs on this computer over your Wi-Fi — same graph, same memory.</>}
                  </div>
                  {mode === 'anywhere' && status?.on && <div className="pair-status"><span className="dot-live" /> Reachable · {status.phones} phone{status.phones === 1 ? '' : 's'} connected</div>}
                  <div className="pair-url">{mode === 'anywhere' ? url.replace(/#.*/, '#…') : url}</div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

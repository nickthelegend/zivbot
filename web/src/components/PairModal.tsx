import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { userId } from '../api';
import { Icon } from './icons';

/** Pair the Android app: a QR code for this computer's LAN address + your graph id. */
export function PairModal() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState('');
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener('zivbot:pair', on);
    return () => window.removeEventListener('zivbot:pair', on);
  }, []);
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const desk = (window as any).zivbotDesktop;
      const base = desk ? await desk.lanUrl() : location.origin;
      const u = `${base}/?pair=${userId}`;
      setUrl(u);
      setQr(await QRCode.toDataURL(u, { margin: 1, width: 240, color: { dark: '#141414', light: '#ffffff' } }));
    })();
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal pair-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2><Icon.phone size={18} /> Pair your phone</h2><button className="icon-btn" onClick={() => setOpen(false)}><Icon.close size={18} /></button></div>
        <div className="modal-body pair-body">
          {qr && <img className="pair-qr" src={qr} width={240} height={240} alt="Pairing QR code" />}
          <div className="muted">Open the ZivBot app on Android and scan this, or paste the link. Your phone talks to the dots on this computer over your Wi-Fi — same graph, same memory.</div>
          <div className="pair-url">{url}</div>
          {(window as any).ReactNativeWebView && <button className="btn ghost sm" onClick={() => (window as any).ReactNativeWebView.postMessage(JSON.stringify({ type: 'unpair' }))}>Disconnect this phone</button>}
        </div>
      </div>
    </div>
  );
}

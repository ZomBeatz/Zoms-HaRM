/* Showing a saved login for a minute: password, live 2FA code, and buttons that open what it's for. */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { fmtDay, splitCode, totpNow, downloadText, type Row } from '../lib/util';
import { copy, modal, toast, type ModalCtl } from '../ui/overlay';
import { A, ExtLink, EyeButton, KV, Small } from '../ui/bits';

/* Buttons that open what a login is for. Browsers never let one site type into another
   site's login form, so opening a web page copies the password on the same click. */
function LaunchPanel({ c, sec }: { c: Row; sec: Row }) {
  const targets: Row[] = sec.targets || [];
  if (!targets.length) return null;
  const user = c.username || '';
  const copyPw = () => { if (sec.password) copy(sec.password, 'Password'); };
  return (
    <div className="launch">
      {targets.map((t, i) => {
        if (t.type === 'web') return <a key={i} className="button primary" href={t.url} target="_blank" rel="noopener noreferrer" onClick={copyPw}>
          {`↗ ${t.label}`}<span className="launch-sub">{t.url.replace(/^https?:\/\//, '')}</span></a>;
        if (t.type === 'ssh') {
          const cmd = `ssh ${user ? user + '@' : ''}${t.host}${t.port && t.port !== 22 ? ' -p ' + t.port : ''}`;
          return <div key={i} className="launch-row"><code>{cmd}</code><Small label="Copy command" onClick={() => copy(cmd, 'SSH command')} />
            <a className="button sm" href={`ssh://${user ? encodeURIComponent(user) + '@' : ''}${t.host}${t.port && t.port !== 22 ? ':' + t.port : ''}`} onClick={copyPw}>Open in SSH app</a></div>;
        }
        if (t.type === 'rdp') return <div key={i} className="launch-row"><code>{`RDP → ${t.host}`}</code>
          <Small label="Download .rdp file" onClick={() => {
            copyPw();
            downloadText(`${t.host}.rdp`, `full address:s:${t.host}\r\n${user ? `username:s:${user}\r\n` : ''}prompt for credentials:i:1\r\n`, 'application/x-rdp');
          }} /></div>;
        return null;
      })}
      <p className="muted small">{sec.password
        ? 'Opening copies the password, so just paste it into the login box. After the first login, let your browser save it for true one-click sign-in next time.'
        : 'No password stored for this login.'}</p>
    </div>
  );
}

function Reveal({ c, sec, m }: { c: Row; sec: Row; m: ModalCtl }) {
  const [shown, setShown] = useState(false);
  const [code, setCode] = useState<string>(sec.totp_code || '');
  const [left, setLeft] = useState(30);
  useEffect(() => {
    let ticks = 0;
    const tick = async () => {
      if (++ticks > 60) { m.close(); return; }
      if (sec.totp_secret && window.crypto?.subtle) {
        try { setCode(await totpNow(sec.totp_secret)); } catch { /* keep the server's code */ }
        setLeft(30 - Math.floor(Date.now() / 1000) % 30);
      }
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="reveal">
      <LaunchPanel c={c} sec={sec} />
      <KV pairs={[
        ['Label', c.label],
        ['Kind', c.kind],
        ['Device', c.device_name ? <A href={`#/devices/${c.device_id}`}>{c.device_name}</A> : ''],
        ['URL', <ExtLink url={c.url} />],
        ['Username', c.username ? <span className="inline"><code>{c.username}</code><Small label="Copy" onClick={() => copy(c.username, 'Username')} /></span> : ''],
        ['Password', sec.password != null ? <span className="inline"><code className="secret">{shown ? sec.password : '•'.repeat(12)}</code>
          <EyeButton shown={shown} setShown={setShown} /><Small label="Copy" onClick={() => copy(sec.password, 'Password')} /></span> : ''],
        ['2FA code', sec.totp_secret ? <span className="inline"><code className="secret big totp">{splitCode(code)}</code>
          <span className="totp-ring" role="img" aria-label={`${left} seconds left`} title={`${left} seconds left`} style={{ '--p': String(left / 30) } as React.CSSProperties} />
          <Small label="Copy" onClick={() => copy(code, '2FA code')} /></span> : ''],
        ['Last rotated', fmtDay(c.last_rotated)],
      ]} />
      {sec.secret_notes ? <><h4>Secret notes</h4><pre className="secret-notes">{sec.secret_notes}</pre></> : null}
      <p className="muted small">This window closes automatically after 60 seconds. Reveals are recorded in the audit log.</p>
    </div>
  );
}

export async function revealCredential(c: Row) {
  let sec: Row;
  try { sec = await api('POST', `/credentials/${c.id}/reveal`); }
  catch (e) { toast((e as Error).message, 'bad'); return; }
  modal('🔑 ' + c.label, m => <Reveal c={c} sec={sec} m={m} />);
}

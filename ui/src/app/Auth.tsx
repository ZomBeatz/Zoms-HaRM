/* Unlocking, creating the master password, and using the recovery code. */
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client';
import { S, useApp } from '../lib/state';
import { copy, modal } from '../ui/overlay';
import { Small } from '../ui/bits';
import { startApp } from './session';
import { themeIcon } from './theme';
import { BrandName } from './Shell';

interface AuthField { k: string; label: string; type?: string; ac?: string; inputmode?: React.HTMLAttributes<HTMLInputElement>['inputMode']; ph?: string; optional?: boolean }

function AuthForm({ fields, submitLabel, onSubmit, footer }: { fields: AuthField[]; submitLabel: string; onSubmit: (v: Record<string, string>) => Promise<void>; footer: React.ReactNode }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => { setTimeout(() => first.current?.focus(), 0); }, []);
  return (
    <form onSubmit={async e => {
      e.preventDefault();
      setErr('');
      setBusy(true);
      try { await onSubmit(vals); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      {fields.map((f, i) => (
        <div key={f.k} className="field"><label htmlFor={id + f.k}>{f.label}</label>
          <input id={id + f.k} ref={i === 0 ? first : undefined} type={f.type || 'password'} autoComplete={f.ac || 'off'} required={!f.optional}
            inputMode={f.inputmode} placeholder={f.ph} value={vals[f.k] || ''} onChange={e => setVals(v => ({ ...v, [f.k]: e.target.value }))} />
        </div>
      ))}
      <div className="form-error" role="alert">{err}</div>
      <button className="primary block" type="submit" disabled={busy}>{submitLabel}</button>
      {footer}
    </form>
  );
}

export function showRecoveryCode(code: string, then?: () => void, extra?: string) {
  function Body({ close }: { close: () => void }) {
    const [ok, setOk] = useState(false);
    return (
      <div>
        <p>This is the only way back in if you forget your master password. Store it somewhere safe and offline. It will not be shown again.</p>
        {extra ? <p className="warn-text">{extra}</p> : null}
        <div className="recovery"><code>{code}</code><Small label="Copy" onClick={() => copy(code, 'Recovery code')} /></div>
        <label className="check"><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>I have saved my recovery code</span></label>
        <div className="actions"><button className="primary" type="button" disabled={!ok} onClick={() => { close(); then?.(); }}>Continue</button></div>
      </div>
    );
  }
  modal('Save your recovery code', m => <Body close={() => m.close(true)} />, { noClose: true, beforeClose: () => false });
}

export function AuthScreen() {
  const msg = useApp(s => s.authMsg);
  const [mode, setMode] = useState<'loading' | 'login' | 'setup' | 'recover'>('loading');
  const [err, setErr] = useState('');
  useEffect(() => {
    api('GET', '/auth/status').then(st => { S.auth = st; setMode(st.setup ? 'login' : 'setup'); }).catch(e => setErr(e.message));
  }, []);
  const link = (label: string, to: 'login' | 'recover') =>
    <p className="small center"><a href="#" onClick={e => { e.preventDefault(); setMode(to); }}>{label}</a></p>;
  let body: React.ReactNode = err ? <div className="form-error">{err}</div> : null;
  if (mode === 'setup') body = <AuthForm key="setup" submitLabel="Create vault" fields={[
    { k: 'pw', label: 'Create a master password (10+ characters)', ac: 'new-password' },
    { k: 'pw2', label: 'Confirm master password', ac: 'new-password' },
  ]} onSubmit={async v => {
    if (v.pw !== v.pw2) throw new Error('Passwords do not match');
    const r = await api('POST', '/auth/setup', { password: v.pw });
    showRecoveryCode(r.recovery_code, () => { location.hash = '#/setup'; startApp(); });
  }} footer={<p className="muted small">Your master password encrypts every stored login. It is never stored and cannot be recovered without the recovery code shown next.</p>} />;
  if (mode === 'login') {
    const fields: AuthField[] = [{ k: 'password', label: 'Master password', ac: 'current-password' }];
    if (S.auth?.totp_enabled) fields.push({ k: 'totp', label: '2FA code', type: 'text', ac: 'one-time-code', inputmode: 'numeric', ph: '123456' });
    body = <AuthForm key="login" submitLabel="Unlock" fields={fields} onSubmit={async v => { await api('POST', '/auth/login', v); await startApp(); }}
      footer={link('Forgot your password? Use the recovery code', 'recover')} />;
  }
  if (mode === 'recover') body = <AuthForm key="recover" submitLabel="Reset password" fields={[
    { k: 'recovery_code', label: 'Recovery code', type: 'text', ph: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' },
    { k: 'new_password', label: 'New master password', ac: 'new-password' },
    { k: 'pw2', label: 'Confirm new password', ac: 'new-password' },
  ]} onSubmit={async v => {
    if (v.new_password !== v.pw2) throw new Error('Passwords do not match');
    const r = await api('POST', '/auth/recover', { recovery_code: v.recovery_code, new_password: v.new_password });
    showRecoveryCode(r.recovery_code, startApp, 'Your old recovery code no longer works, and 2FA has been turned off.');
  }} footer={link('Back to unlock', 'login')} />;
  return (
    <div className="auth-wrap"><div className="auth-card">
      <div className="brand big"><img className="brand-icon" src={themeIcon()} alt="" />
        <div><BrandName /><div className="brand-sub">Hardware &amp; Rack Manager</div></div></div>
      {msg ? <div className="notice">{msg}</div> : null}
      <div id="auth-body">{body}</div>
    </div></div>
  );
}

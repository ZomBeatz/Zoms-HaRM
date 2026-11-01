/* The whole app: starting up, the lock screen, or the pages. */
import { useEffect, useState } from 'react';
import { useApp } from '../lib/state';
import { Overlays } from '../ui/overlay';
import { AuthScreen } from './Auth';
import { Shell } from './Shell';
import { startApp } from './session';
import { TroubleshootingContent } from '../pages/Troubleshooting';

function StartError({ message }: { message: string }) {
  const [help, setHelp] = useState(false);
  return (
    <div className="boot boot-error"><p>{'HaRM couldn’t start. ' + message}</p>
      <div className="inline center-row">
        <button type="button" className="primary" onClick={() => location.reload()}>⟳ Try again</button>
        <button type="button" onClick={() => setHelp(h => !h)}>{help ? 'Hide troubleshooting steps' : 'Show troubleshooting steps'}</button>
      </div>
      <div className="boot-help" hidden={!help}><TroubleshootingContent /></div>
    </div>
  );
}

export function App() {
  const screen = useApp(s => s.screen);
  const startError = useApp(s => s.startError);
  useEffect(() => { startApp().catch(e => useApp.setState({ screen: 'error', startError: e.message })); }, []);
  return (
    <>
      {screen === 'boot' ? <div className="boot">{window.harmDemo ? 'Starting the online demo…' : 'Loading…'}</div> : null}
      {screen === 'error' ? <StartError message={startError} /> : null}
      {screen === 'auth' ? <AuthScreen /> : null}
      {screen === 'app' ? <Shell /> : null}
      <Overlays />
    </>
  );
}

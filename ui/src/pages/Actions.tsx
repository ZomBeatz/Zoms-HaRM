import { GET } from '../api/client';
import { Btn, Card, HelpLink, PageHead } from '../ui/bits';
import { ActionExamples, ActionsTable, editAction } from '../lib/actions';
import { Pending, useLoad } from '../app/router';

export default function Actions() {
  const q = useLoad(() => GET('/actions'));
  if (!q.data) return <Pending q={q} />;
  const back = q.reload;
  return <>
    <PageHead title="Actions" sub="Commands you send to your devices with one click: quiet the fans, update, restart.">
      <Btn label="+ New action" onClick={() => editAction({}, back)} cls="primary" /><HelpLink s="actions" />
    </PageHead>
    {q.data.length ? <Card title={`Your actions · ${q.data.length}`}><ActionsTable rows={q.data} after={back} /></Card>
      : <div className="empty-state"><div className="empty-ico">⚡</div>
        <p>Save a command once, then send it to a device over SSH with one click, from here, its page or the Status page.</p>
        <Btn label="+ New action" onClick={() => editAction({}, back)} cls="primary" /></div>}
    <Card title="Start from an example"><div>
      <p className="muted small">These fill in the form for you. Check the commands before you run them on your own gear.</p>
      <ActionExamples preset={{}} after={back} />
    </div></Card>
  </>;
}

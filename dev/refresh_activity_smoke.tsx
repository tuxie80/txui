import { useState } from 'react';
import { EnvironmentRefreshPanel } from '../src/components/EnvironmentRefreshPanel';
import { getAllActivities } from '../src/store/tabActivity';
import type { Session } from '../src/types';

interface Props {
  session: Session;
  openSessions: Session[];
}

export function RefreshActivitySmoke({ session, openSessions }: Props) {
  const [closed, setClosed] = useState(false);
  const activity = getAllActivities().find(item => item.activity.id === 'refresh-execute')?.activity;
  return (
    <>
      {!closed && <EnvironmentRefreshPanel session={session} openSessions={openSessions} onClose={() => setClosed(true)} />}
      <section aria-label="Refresh activity after panel close">
        {activity ? (
          <>
            <span>{activity.id} · {activity.label} · {activity.detail}</span>
            <button onClick={() => void activity.kill?.()}>Cancel hidden work</button>
          </>
        ) : <span>No running Refresh activity</span>}
      </section>
    </>
  );
}

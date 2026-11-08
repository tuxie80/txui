import { createRoot } from 'react-dom/client';
import { QueryLabPanel } from '../src/components/QueryLabPanel';
import type { Session } from '../src/types';
import '../src/App.css';
import { initTheme } from '../src/utils/themes';

initTheme();

const session = {
  connectionId: 'c-lab', sessionId: 's-lab', connectionName: 'lab-visual',
  engine: 'mysql', environment: 'dev', readOnly: false,
} as Session;

createRoot(document.getElementById('root')!).render(
  <QueryLabPanel session={session} schema="shop" onClose={() => {}} />,
);

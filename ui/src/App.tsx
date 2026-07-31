import { AppShell } from './components/shell/AppShell.js';
import { useRoute } from './lib/use-route.js';
import { Sessions } from './pages/Sessions.js';
import { Showcase } from './pages/Showcase.js';

export function App() {
  const route = useRoute();
  /*
   * Scope note, updated by Task 5.2b: the session list is now real, and the
   * placeholder landing page it replaced is deleted. `session`, `trace` and
   * `not_found` still fall through to it — a deep link resolves to a real route
   * and then shows the list. That remains correct-by-scope rather than a bug:
   * 5.3 ships the session view, 5.4 the span detail, and 5.5 owns "any deep
   * link cold-loads to the exact view state".
   *
   * At 5.3 this ternary becomes a switch, and this comment is the reason it
   * must.
   */
  return <AppShell>{route.name === 'showcase' ? <Showcase /> : <Sessions />}</AppShell>;
}

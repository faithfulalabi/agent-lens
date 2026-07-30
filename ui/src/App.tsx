import { AppShell } from './components/shell/AppShell.js';
import { useRoute } from './lib/use-route.js';
import { Home } from './pages/Home.js';
import { Showcase } from './pages/Showcase.js';

export function App() {
  const route = useRoute();
  /*
   * Scope note (Task 5.1c): the route TABLE is this task's contract; rendering
   * the views behind it is not. So `session`, `trace` and `not_found` all fall
   * through to the landing page for now — a deep link resolves to a real route
   * and then shows Home. That is correct-by-scope rather than a bug: Task 5.2
   * replaces Home with the session list, 5.3 ships the session view, 5.4 the
   * span detail, and 5.5 owns "any deep link cold-loads to the exact view
   * state". Shipping a fourth placeholder page now would be a file three later
   * tasks all delete.
   *
   * At 5.3 this ternary becomes a switch, and this comment is the reason it
   * must.
   */
  return <AppShell>{route.name === 'showcase' ? <Showcase /> : <Home />}</AppShell>;
}

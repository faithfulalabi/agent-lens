import { AppShell } from './components/shell/AppShell.js';
import { Home } from './pages/Home.js';
import { Showcase } from './pages/Showcase.js';

export function App() {
  // TEMPORARY (Task 5.1a) — replaced by Task 5.1c's matchRoute.
  // Works in dev because Vite's default `appType: 'spa'` serves index.html for
  // unknown paths, and keeps working once 5.1b's SPA fallback lands. No test
  // depends on this switch — the token tests render <Showcase /> directly.
  const isShowcase = window.location.pathname === '/showcase';
  return <AppShell>{isShowcase ? <Showcase /> : <Home />}</AppShell>;
}

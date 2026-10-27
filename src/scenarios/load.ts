import type { Scenario } from '../run.ts';
import { formatBytes, formatDuration } from '../util.ts';
import { checkLayout } from './common.ts';

export default {
  name: 'load',
  title: 'Loading',
  async run(t) {
    await t.use({ label: 'Desktop' }, async (s) => {
      if (!(await s.load())) return;
      t.note(`Called /wallet/authenticate ${formatDuration(s.authenticatedAfter)} after opening`);
      await s.start();
      await s.shot('loaded');
      t.note(`Downloaded ${formatBytes(s.bytes)} before settling`);

      const auth = s.rgs.calls.find((call) => call.path === '/wallet/authenticate');
      if (auth && !auth.body.language) t.findings.info('rgs/language', "/wallet/authenticate didn't send a language");

      const layout = await s.layout();
      checkLayout(t, layout, 'desktop size');
      if (layout && !layout.viewport) {
        t.findings.warn('layout/viewport-meta', 'No <meta name="viewport"> tag; phones will zoom the page out');
      }
      if (layout && !layout.canvas) t.findings.info('layout/canvas', 'No <canvas> on the page after loading');
    });
  },
} satisfies Scenario;

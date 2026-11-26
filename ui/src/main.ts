import './styles.css';
import { ChartApp } from './app';

const root = document.getElementById('app');

function fatal(message: string): void {
  document.body.replaceChildren(
    Object.assign(document.createElement('pre'), {
      textContent: `chart client failed to start\n\n${message}`,
      style: 'color:#e8555c;padding:24px;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap',
    }),
  );
}

if (!root) {
  fatal('the page shell is missing its #app element');
} else {
  const app = new ChartApp(root);
  app.start().catch((error: unknown) => {
    fatal(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  });
}

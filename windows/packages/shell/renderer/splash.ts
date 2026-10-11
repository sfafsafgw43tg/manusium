/** packages/shell/renderer/splash.ts - fills product name / version from the query string. */
const q = new URLSearchParams(location.search);
const app = q.get('app') === 'octodetect' ? 'octodetect' : 'octobrowser';
document.body.dataset.app = app;
(document.getElementById('name') as HTMLElement).textContent = app === 'octodetect' ? 'OctoDetect.su' : 'Octo.su';
(document.getElementById('ver') as HTMLElement).textContent = `v${(q.get('v') ?? '').replace(/[^\w.-]/g, '')}`;

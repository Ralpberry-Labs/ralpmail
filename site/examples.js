const exampleCode = document.querySelector('#command');
const copyButton = document.querySelector('.copy');
const status = document.querySelector('#example-status');
const examples = {
  receipt: exampleCode.textContent,
  otp: command('/otp/challenges', 'signup-1001', {
    email: 'customer@example.com', purpose: 'signup',
  }),
  campaign: command('/campaigns', 'newsletter-november', {
    subject: 'November newsletter', text: 'Here is what we shipped this month.',
  }),
};

function command(path, key, payload) {
  const slash = String.fromCharCode(92);
  const body = JSON.stringify(payload, null, 2).replaceAll('\n', '\n  ');
  return [
    'curl http://127.0.0.1:3000' + path + ' ' + slash,
    '  -H "Authorization: Bearer $RALPMAIL_API_KEY" ' + slash,
    "  -H 'Content-Type: application/json' " + slash,
    "  -H 'Idempotency-Key: " + key + "' " + slash,
    "  -d '" + body + "'",
  ].join('\n');
}

const buttons = document.querySelectorAll('[data-example]');
for (const button of buttons) {
  button.addEventListener('click', () => {
    exampleCode.textContent = examples[button.dataset.example];
    for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
    copyButton.textContent = 'Copy';
    status.textContent = button.textContent + ' example displayed.';
  });
}

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(exampleCode.textContent);
    copyButton.textContent = 'Copied';
    status.textContent = 'Example copied.';
  } catch {
    status.textContent = 'Clipboard unavailable. Select and copy the code manually.';
    copyButton.textContent = 'Copy manually';
  }
});

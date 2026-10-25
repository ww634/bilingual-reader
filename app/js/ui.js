// Shared in-app confirmations. The caller performs the action only after approval.
let confirmationQueue = Promise.resolve();
export function confirmAction({ title = 'Please confirm', message, confirmLabel = 'Continue', destructive = true }) {
  const run = () => new Promise(resolve => {
    const oldFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const panel = document.createElement('section');
    panel.className = 'confirm-panel'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-modal','true');
    const heading = document.createElement('h2'); heading.id = 'confirm-title'; heading.textContent = title;
    panel.setAttribute('aria-labelledby', heading.id);
    const text = document.createElement('p'); text.textContent = message;
    const actions = document.createElement('div'); actions.className = 'data-actions';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const approve = document.createElement('button'); approve.className = destructive ? 'danger' : 'btn-primary'; approve.textContent = confirmLabel;
    const finish = value => { overlay.remove(); document.removeEventListener('keydown',keys); oldFocus?.focus(); resolve(value); };
    const keys = e => { if(e.key==='Escape'){e.preventDefault();finish(false)} if(e.key==='Tab'){e.preventDefault();(document.activeElement===cancel?approve:cancel).focus()} };
    cancel.onclick = () => finish(false); approve.onclick = () => finish(true);
    overlay.onclick = e => { if(e.target===overlay)finish(false) };
    actions.append(cancel,approve); panel.append(heading,text,actions); overlay.append(panel); document.body.append(overlay);
    document.addEventListener('keydown',keys); cancel.focus();
  });
  const result = confirmationQueue.then(run); confirmationQueue = result.catch(()=>{}); return result;
}
export function openAISettings() { window.dispatchEvent(new CustomEvent('app:settings',{detail:'ai'})); }
export function addKeyButton(parent) {
  const button=document.createElement('button');button.className='pop-act';button.textContent='Add key';button.onclick=openAISettings;parent.append(button);return button;
}

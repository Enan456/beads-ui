import { html, render } from 'lit-html';
import { debug } from '../utils/logging.js';

/**
 * @typedef {{ id: string, from?: string, to?: string, subject?: string, body?: string, timestamp?: string, read?: boolean, priority?: string, type?: string, thread_id?: string }} MailItem
 */

/**
 * Create the Mail List view.
 *
 * @param {HTMLElement} mount_element
 * @param {(type: string, payload?: unknown) => Promise<unknown>} sendFn
 * @param {(hash: string) => void} [navigateFn]
 * @param {{ getState: () => any, setState: (patch: any) => void, subscribe: (fn: (s:any)=>void)=>()=>void }} [store]
 * @param {{ selectors: { getIds: (client_id: string) => string[] } }} [_subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [mail_stores]
 * @returns {{ load: () => Promise<void>, destroy: () => void }}
 */
export function createMailView(
  mount_element,
  sendFn,
  navigateFn,
  store,
  _subscriptions = undefined,
  mail_stores = undefined
) {
  const log = debug('views:mail');
  /** @type {any} */ (void _subscriptions);

  /** @type {MailItem[]} */
  let mail_cache = [];
  /** @type {Set<string>} */
  const expanded_items = new Set();
  /** @type {null | (() => void)} */
  let unsubscribe = null;

  /**
   * Format timestamp to readable date/time
   * @param {string | undefined} timestamp
   * @returns {string}
   */
  function formatTimestamp(timestamp) {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return timestamp;
    }
  }

  /**
   * Toggle expanded state for a mail item
   * @param {string} id
   */
  function toggleExpand(id) {
    if (expanded_items.has(id)) {
      expanded_items.delete(id);
    } else {
      expanded_items.add(id);
    }
    doRender();
  }

  /**
   * Build lit-html template for the mail view.
   */
  function template() {
    return html`
      <div class="panel__header">
        <h2>Mail</h2>
      </div>
      <div class="panel__body">
        ${mail_cache.length === 0
          ? html`<div style="padding: 20px; color: var(--muted);">
              No mail messages
            </div>`
          : html`
              <div class="mail-list">
                ${mail_cache.map((item) => {
                  const is_expanded = expanded_items.has(item.id);
                  return html`
                    <div
                      class="mail-item ${is_expanded ? 'expanded' : ''} ${item.read === false ? 'unread' : ''}"
                    >
                      <div
                        class="mail-item__header"
                        @click=${() => toggleExpand(item.id)}
                      >
                        <div class="mail-item__meta">
                          <span class="mail-item__from"
                            >${item.from || 'Unknown'}</span
                          >
                          <span class="mail-item__timestamp"
                            >${formatTimestamp(item.timestamp)}</span
                          >
                        </div>
                        <div class="mail-item__subject">
                          ${item.subject || '(no subject)'}
                        </div>
                      </div>
                      ${is_expanded
                        ? html`
                            <div class="mail-item__body">
                              <div class="mail-item__to">
                                To: ${item.to || ''}
                              </div>
                              <div class="mail-item__content">
                                ${item.body || ''}
                              </div>
                            </div>
                          `
                        : ''}
                    </div>
                  `;
                })}
              </div>
            `}
      </div>
    `;
  }

  /**
   * Render the current mail_cache.
   */
  function doRender() {
    render(template(), mount_element);
  }

  // Initial render
  doRender();

  /**
   * Load mail list data via subscription.
   */
  async function load() {
    try {
      log('subscribing to mail-inbox');
      const resp = /** @type {{ client_id?: string }} */ (
        await sendFn('subscribe', { type: 'mail-inbox' })
      );
      const client_id = resp.client_id || '';
      log('mail-inbox subscription client_id=%s', client_id);

      if (mail_stores && client_id) {
        // Subscribe to snapshot changes
        unsubscribe = mail_stores.subscribe?.(() => {
          const snapshot = mail_stores.snapshotFor?.(client_id) || [];
          mail_cache = snapshot.slice();
          doRender();
        });
        // Initial snapshot
        const snapshot = mail_stores.snapshotFor?.(client_id) || [];
        mail_cache = snapshot.slice();
        doRender();
      }
    } catch (err) {
      log('failed to load mail: %o', err);
    }
  }

  /**
   * Cleanup subscriptions.
   */
  function destroy() {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  return { load, destroy };
}

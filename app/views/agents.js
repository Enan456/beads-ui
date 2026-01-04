import { html, render } from 'lit-html';
import { debug } from '../utils/logging.js';

/**
 * @typedef {{ id: string, name?: string, address?: string, role?: string, session?: string, running?: boolean, has_work?: boolean, unread_mail?: number, first_subject?: string, rig?: string }} AgentItem
 */

/**
 * Create the Agents view.
 *
 * @param {HTMLElement} mount_element
 * @param {(type: string, payload?: unknown) => Promise<unknown>} sendFn
 * @param {(hash: string) => void} [navigateFn]
 * @param {{ getState: () => any, setState: (patch: any) => void, subscribe: (fn: (s:any)=>void)=>()=>void }} [store]
 * @param {{ selectors: { getIds: (client_id: string) => string[] } }} [_subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [agent_stores]
 * @returns {{ load: () => Promise<void>, destroy: () => void }}
 */
export function createAgentsView(
  mount_element,
  sendFn,
  navigateFn,
  store,
  _subscriptions = undefined,
  agent_stores = undefined
) {
  const log = debug('views:agents');
  /** @type {any} */ (void _subscriptions);

  /** @type {AgentItem[]} */
  let agent_cache = [];
  /** @type {null | (() => void)} */
  let unsubscribe = null;

  /**
   * Group agents by rig (or "town" for town-level agents).
   * @param {AgentItem[]} agents
   * @returns {{ [rig: string]: AgentItem[] }}
   */
  function groupByRig(agents) {
    /** @type {{ [rig: string]: AgentItem[] }} */
    const groups = {};
    for (const agent of agents) {
      const rig = agent.rig || 'town';
      if (!groups[rig]) {
        groups[rig] = [];
      }
      groups[rig].push(agent);
    }
    return groups;
  }

  /**
   * Get status indicator color based on agent state.
   * @param {AgentItem} agent
   * @returns {string}
   */
  function getStatusColor(agent) {
    if (agent.running) {
      if (agent.has_work) return '#10b981'; // green-500 with work
      return '#6b7280'; // gray-500 running but idle
    }
    return '#9ca3af'; // gray-400 stopped
  }

  /**
   * Get role icon based on agent role.
   * @param {string} role
   * @returns {string}
   */
  function getRoleIcon(role) {
    switch (role) {
      case 'coordinator':
        return '🎩'; // mayor
      case 'health-check':
        return '🐺'; // deacon
      case 'witness':
        return '🦉';
      case 'refinery':
        return '🏭';
      case 'polecat':
        return '😺';
      case 'crew':
        return '👷';
      default:
        return '🤖';
    }
  }

  /**
   * Build lit-html template for the agents view.
   */
  function template() {
    const groups = groupByRig(agent_cache);
    const rigNames = Object.keys(groups).sort((a, b) => {
      // Town first, then alphabetical
      if (a === 'town') return -1;
      if (b === 'town') return 1;
      return a.localeCompare(b);
    });

    return html`
      <div class="panel__header">
        <h2>Agents</h2>
      </div>
      <div class="panel__body">
        ${agent_cache.length === 0
          ? html`<div style="padding: 20px; color: var(--muted);">
              No agents found
            </div>`
          : html`
              <div class="agents-container">
                ${rigNames.map((rigName) => {
                  const agents = groups[rigName];
                  return html`
                    <div class="agents-rig">
                      <h3 class="agents-rig__name">
                        ${rigName === 'town' ? '🏙️ Town' : `📁 ${rigName}`}
                      </h3>
                      <div class="agents-list">
                        ${agents.map((agent) => {
                          const statusColor = getStatusColor(agent);
                          const roleIcon = getRoleIcon(agent.role || '');
                          return html`
                            <div class="agent-item">
                              <div class="agent-item__status">
                                <span
                                  class="status-indicator"
                                  style="background-color: ${statusColor}"
                                  title="${agent.running ? 'Running' : 'Stopped'}"
                                ></span>
                              </div>
                              <div class="agent-item__icon">${roleIcon}</div>
                              <div class="agent-item__info">
                                <div class="agent-item__name">
                                  ${agent.name || agent.address}
                                </div>
                                <div class="agent-item__meta">
                                  <span class="agent-item__role"
                                    >${agent.role}</span
                                  >
                                  ${agent.has_work
                                    ? html`<span
                                        class="agent-item__work"
                                        title="Has work on hook"
                                        >🪝</span
                                      >`
                                    : ''}
                                  ${agent.unread_mail && agent.unread_mail > 0
                                    ? html`<span
                                        class="agent-item__mail"
                                        title="${agent.unread_mail} unread"
                                        >📬 ${agent.unread_mail}</span
                                      >`
                                    : ''}
                                </div>
                              </div>
                            </div>
                          `;
                        })}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `}
      </div>
    `;
  }

  /**
   * Render the current agent_cache.
   */
  function doRender() {
    render(template(), mount_element);
  }

  // Initial render
  doRender();

  /**
   * Load agent status data via subscription.
   */
  async function load() {
    try {
      log('subscribing to agent-status');
      const resp = /** @type {{ client_id?: string }} */ (
        await sendFn('subscribe', { type: 'agent-status' })
      );
      const client_id = resp.client_id || '';
      log('agent-status subscription client_id=%s', client_id);

      if (agent_stores && client_id) {
        // Subscribe to snapshot changes
        unsubscribe = agent_stores.subscribe?.(() => {
          const snapshot = agent_stores.snapshotFor?.(client_id) || [];
          agent_cache = snapshot.slice();
          doRender();
        });
        // Initial snapshot
        const snapshot = agent_stores.snapshotFor?.(client_id) || [];
        agent_cache = snapshot.slice();
        doRender();
      }
    } catch (err) {
      log('failed to load agents: %o', err);
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

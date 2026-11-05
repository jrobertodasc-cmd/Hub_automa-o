// src/utils/events.js
// Gerenciamento de eventos em tempo real (SSE) e tarefas ativas

const sseClients = new Set();
const activeTasks = {};

function broadcastDockEvent(payload, targetTenantId = null) {
    if (sseClients.size === 0) return;
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        try {
            // Isolamento multi-tenant: se o evento possui tenant_id específico, só entrega aos clientes daquele tenant
            if (targetTenantId && client.tenantId && client.tenantId !== targetTenantId) {
                continue;
            }
            client.write(msg);
        } catch (err) {
            sseClients.delete(client);
        }
    }
}

module.exports = {
    sseClients,
    activeTasks,
    broadcastDockEvent
};

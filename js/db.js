// js/db.js
// Importando o Dexie via CDN (para producao em campo offline, 
// o Service Worker fara o cache deste arquivo)
import Dexie from './dexie.mjs';

// Inicializa o banco de dados
export const db = new Dexie('ParcelasDB');

// Definicao do Esquema Relacional
// Os índices listados aqui sao as colunas pelas quais podemos fazer buscas rapidas.
db.version(1).stores({
  campaigns: '++id, name, year',
  plots: 'id, campaignId, fazenda, talhao, numero, status',
  trees: 'id, plotId, fila, cova, fuste, sync_status, [plotId+fila+cova+fuste]',
  history: 'id, plotId, fila, cova, fuste'
});

/**
 * Função utilitaria para gerar UUIDs (Identificadores unicos Universais) v4.
 * Essencial para evitar colisoes quando multiplos dispositivos exportarem 
 * dados para o mesmo banco de dados central no futuro.
 */
export function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : 
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
}
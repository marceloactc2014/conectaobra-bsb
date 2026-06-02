'use strict';

// ============================================================
// netlify/functions/extrair-pdf.js
// MetaObra — Proxy seguro para API Deepseek
//
// A chave DEEPSEEK_API_KEY vive nas variáveis de ambiente
// do Netlify (Site settings → Environment variables).
// Ela NUNCA chega ao navegador.
//
// Deploy: basta fazer push no GitHub — Netlify publica sozinho.
// Rota gerada: /.netlify/functions/extrair-pdf
// ============================================================

const OpenAI = require('openai');

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY, // sua chave da DeepSeek
  baseURL: 'https://api.deepseek.com/v1', // endpoint da DeepSeek
});

// ── Origens permitidas ─────────────────────────────────────
// Adicione aqui o domínio real do seu site no Netlify
const ALLOWED_ORIGINS = [
  'https://metaobra.com.br',   // ← substitua pelo seu domínio Netlify
  'https://metaobra.com.br',        // ← seu domínio customizado (se houver)
  'http://localhost:5500',           // live-server local
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

// ── Helper: monta headers CORS corretos ───────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Panel-Token',
    'Content-Type': 'application/json',
  };
}

// ── Handler principal ──────────────────────────────────────
exports.handler = async (event) => {
  const origin = event.headers['origin'] || event.headers['Origin'] || '';
  const headers = corsHeaders(origin);

  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Só aceita POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido.' }) };
  }

  // ── Valida token interno do painel ─────────────────────
  const token    = event.headers['x-panel-token'] || event.headers['X-Panel-Token'] || '';
  const expected = process.env.PANEL_SECRET || 'metaobra2025';
  if (!token || token !== expected) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token inválido.' }) };
  }

  // ── Valida chave Anthropic configurada ─────────────────
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY não definida nas variáveis de ambiente do Netlify.');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Configuração do servidor incompleta. Contate o administrador.' }),
    };
  }

  // ── Parse do body ──────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido.' }) };
  }

  const { pdfBase64, fileName = 'orcamento.pdf' } = body;

  if (!pdfBase64 || typeof pdfBase64 !== 'string' || pdfBase64.length < 100) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Campo pdfBase64 ausente ou inválido.' }) };
  }

  // Limite de tamanho: ~10 MB em base64 ≈ ~7.5 MB PDF
  if (pdfBase64.length > 14_000_000) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'PDF muito grande. Limite: ~10 MB.' }) };
  }

  // ── Chama a API Anthropic (chave nunca vai ao front) ───
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1800,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text: `Analise este orçamento de energia solar e extraia as informações em JSON puro (sem markdown, sem backticks, sem texto adicional). Retorne APENAS o JSON com esta estrutura exata:
{
  "fornecedor": "Nome da empresa fornecedora",
  "cliente": "Nome do cliente se presente ou string vazia",
  "potencia": "Ex: 8.98 kWp ou string vazia",
  "consumo": "Ex: 1200 kWh ou string vazia",
  "valor_total": "Ex: R$ 16.703,72 ou string vazia",
  "retorno_investimento": "Ex: 1 ano ou string vazia",
  "economia_30_anos": "Ex: R$ 450.431,21 ou string vazia",
  "equipamentos": [
    {
      "nome": "Nome completo do equipamento",
      "quantidade": "número como string",
      "especificacao": "Detalhes técnicos em até 60 caracteres"
    }
  ],
  "includedServices": ["serviços inclusos no pacote do fornecedor"],
  "garantias": ["garantias mencionadas"],
  "condicoes_pagamento": ["condições de pagamento"],
  "financiamento": [
    {
      "banco": "Nome do banco ou financeira",
      "parcelas": "Ex: 60x de R$ 642,87",
      "carencia": "Ex: 90 dias"
    }
  ],
  "itens_brutos": []
}`,
          },
        ],
      }],
    });

    // Extrai texto da resposta
    const raw = message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    // Parseia JSON
    let fornData;
    try {
      fornData = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { fornData = JSON.parse(match[0]); }
        catch { fornData = { fornecedor: fileName.replace('.pdf', ''), itens_brutos: [] }; }
      } else {
        fornData = { fornecedor: fileName.replace('.pdf', ''), itens_brutos: [] };
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, data: fornData }),
    };

  } catch (err) {
    console.error('[extrair-pdf] Erro Anthropic:', err.message);

    if (err.status === 401) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chave de API inválida.' }) };
    if (err.status === 429) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Limite da API atingido. Tente em instantes.' }) };
    if (err.status === 400) return { statusCode: 400, headers, body: JSON.stringify({ error: 'PDF inválido ou ilegível pela IA.' }) };

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erro interno ao processar o PDF.' }),
    };
  }
};

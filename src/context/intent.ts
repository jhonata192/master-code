import type { IntentKind } from './types.js';

export interface IntentResult {
  intent: IntentKind;
  terms: string[];
  weights: Record<string, number>;
}

export function detectIntent(query: string): IntentResult {
  const t = (query ?? '').toLowerCase();
  const weights: Record<string, number> = {};

  const rules: Array<[IntentKind, RegExp]> = [
    ['bugfix', /(corrig|correc|bug|erro|falha|não funciona|nao funciona|quebr|crashed|exception|fix|broken|downtime)/i],
    ['feature', /(crie|criar|implemente|implementar|adicionar|adiciona|nova funcionalidade|feature|requisito|novo botao|nova tela|suporte a|adicionar suporte)/i],
    ['refactor', /(refator|melhor|simplif|limp|reorganiz|reestrutur|limpar|modularizar)/i],
    ['investigate', /(investigar|descobrir|por que|porque|diagnost|diagnostico|investigue|entender o motivo|rastrear)/i],
    ['test', /(teste|test|rodar os testes|executar testes|testar|unit test)/i],
    ['explain', /(explique|explicar|o que é|o que e|como funciona|entender|entenda|resumir|resuma|explica)/i],
    ['setup', /(configurar projeto|setup|inicializ|começar projeto|novo projeto|iniciar projeto|scaffold|instalar dependencia)/i],
    ['search', /(encontrar|procurar|buscar|localizar|onde está|onde esta|onde fica|pesquisar|ache)/i],
    ['config', /(configuração|configuracao|config|mudar o arquivo de config|alterar config|setting|variavel de ambiente|env)/i],
  ];

  let best: IntentKind = 'general';
  let bestScore = 0;
  const isSpatial = /(onde está|onde esta|onde fica|onde fica o|onde fica a|localizar)/i.test(t);
  for (const [intent, rx] of rules) {
    const m = t.match(rx);
    const words = t.split(/\s+/).filter((w) => rx.test(w)).length;
    let score = m ? m.length * 3 + words : 0;
    if (isSpatial && intent === 'search') score += 5;
    if (isSpatial && intent !== 'search') score -= 2;
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }

  const terms = t
    .split(/[^a-z0-9_.\-/]+/)
    .filter((w) => w.length >= 3);

  switch (best) {
    case 'bugfix':
      weights.file = 1.0;
      weights.decision = 0.2;
      weights.error = 1.2;
      weights.recent = 0.5;
      break;
    case 'feature':
      weights.file = 0.8;
      weights.decision = 0.9;
      weights.requirement = 1.0;
      break;
    case 'refactor':
      weights.file = 1.0;
      weights.decision = 0.6;
      weights.dependency = 0.8;
      break;
    case 'investigate':
      weights.file = 1.0;
      weights.error = 1.2;
      weights.recent = 0.7;
      weights.dependency = 0.7;
      break;
    case 'test':
      weights.file = 0.9;
      weights.test = 1.2;
      weights.error = 0.6;
      break;
    case 'explain':
      weights.decision = 0.8;
      weights.requirement = 0.7;
      weights.recent = 0.3;
      break;
    case 'setup':
      weights.decision = 0.7;
      weights.requirement = 0.7;
      break;
    case 'search':
      weights.file = 1.1;
      weights.dependency = 0.3;
      break;
    case 'config':
      weights.decision = 1.0;
      weights.file = 0.7;
      break;
    default:
      weights.file = 0.6;
      weights.decision = 0.4;
      weights.recent = 0.5;
  }

  return { intent: best, terms, weights };
}

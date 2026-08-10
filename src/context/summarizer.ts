import { getClient } from '../llm.js';
import type { ContextEntry, Summarizer } from './types.js';

const SYSTEM_PROMPT = `Voce e o resumidor de contexto de um agente de codigo. Sua unica tarefa e compactar um trecho do historico da conversa em um resumo em portugues que preserve informacoes essenciais para continuar a tarefa.

Preserve OBRIGATORIAMENTE:
- Objetivo atual da tarefa.
- Decisoes tecnicas ja tomadas e o motivo.
- Arquivos criados, editados ou lidos (caminhos exatos).
- Comandos executados e seus resultados relevantes (builds, testes, erros).
- Restricoes, pendencias e proximos passos planejados.
- Nomes de funcoes/variaveis/classes importantes e como elas se relacionam.

Nao repita o historico integralmente: condense em bullets curtos. Saia com apenas o resumo, sem introducao.`;

export class LLMSummarizer implements Summarizer {
  constructor(
    private getModel: () => string,
    private maxOutputTokens = 1500
  ) {}

  async summarize(entries: ContextEntry[], objective: string, budget: number): Promise<string> {
    const model = this.getModel();
    const body = entries
      .map((e) => {
        const role = e.message.role.toUpperCase();
        const content = (e.message.content ?? '').trim();
        return `[${role}] ${content}`;
      })
      .join('\n\n')
      .slice(0, 60000);

    const client = await getClient();
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Objetivo atual: ${objective || '(nao informado)'}\n\nHistorico a compactar:\n${body}`,
        },
      ],
      max_tokens: Math.min(Math.max(Math.floor(budget * 0.7), 300), this.maxOutputTokens),
    });

    return res.choices[0]?.message?.content?.trim() ?? '(resumo vazio)';
  }
}

export class FakeSummarizer implements Summarizer {
  async summarize(entries: ContextEntry[], objective: string, _budget: number): Promise<string> {
    const files = new Set<string>();
    const commands: string[] = [];
    for (const e of entries) {
      for (const t of e.tags) if (t.startsWith('file:')) files.add(t.slice(5));
      if (e.type === 'command' && e.message.content) commands.push(e.message.content);
    }
    return [
      `Objetivo preservado: ${objective || '(nada)'}`,
      files.size ? `Arquivos tocados: ${[...files].join(', ')}` : 'Nenhum arquivo tocado.',
      commands.length ? `Comandos: ${commands.join(' | ')}` : 'Nenhum comando relevante.',
      '[resumo compactado]',
    ].join('\n');
  }
}

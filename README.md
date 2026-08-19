# PIW Auto Reconnect

Extensão do Google Chrome para monitorar a conexão da hunt no Poke Idle World e tentar recuperá-la automaticamente quando o WebSocket trava ou cai.

## Status

Versão atual: `0.2.0`

Projeto independente e ainda em fase de testes.

## O que a versão 0.2.0 faz

- Monitora o WebSocket usado pelo jogo.
- Identifica a hunt pelo `enter-hunt` enviado pelo próprio jogo.
- Guarda o `slug` da hunt localmente.
- Considera a hunt potencialmente travada somente após 60 segundos sem atividade relevante.
- Tenta recuperar a hunt com `leave-hunt` seguido de `enter-hunt`.
- Detecta queda do WebSocket.
- Usa recarregamento da página como último recurso após uma queda prolongada.
- Mantém o estado necessário para tentar recuperar a hunt depois do reload.
- Exibe apenas o estado da conexão e o número de reconexões.
- Permite arrastar o painel para qualquer posição da tela e salva a posição localmente.

## Instalação para desenvolvimento

1. Abra `chrome://extensions` no Google Chrome.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione a pasta deste projeto.
5. Abra o Poke Idle World.

## Estrutura

```text
PIW-Auto-Reconnect/
├── manifest.json
├── auto-reconnect.js
├── README.md
└── .gitignore
```

## Segurança e privacidade

A extensão foi projetada para ser independente do PIW-QOL e não contém analytics, chamadas externas próprias, coleta de cookies ou envio de credenciais para terceiros.

## Aviso

Este é um projeto independente e não é afiliado ao Poke Idle World.

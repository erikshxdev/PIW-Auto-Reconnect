# PIW Auto Reconnect

Extensão do Google Chrome para o Poke Idle World focada exclusivamente em Auto Reconnect.

## Status

Versão atual: `0.7.0`

Projeto independente e ainda em testes.

## Como funciona

A lógica central segue o fluxo de Auto Reconnect usado pelo PIW-QOL 10.1.0:

- monitora o WebSocket da API do jogo;
- identifica a Hunt pelo `enter-hunt` enviado pelo próprio jogo;
- acompanha mensagens de progresso da Hunt e mudanças do capture bar;
- considera a Hunt potencialmente travada após `2 minutos` sem progresso;
- tenta `leave-hunt` seguido de `enter-hunt` com o mesmo slug;
- aguarda confirmação de progresso antes de contabilizar a reconexão;
- quando o WebSocket permanece fechado, espera `45 segundos` antes do reload;
- preserva o slug e o contador por aba para sobreviver ao reload;
- após o reload, aguarda o novo WebSocket e tenta reentrar na Hunt.

A diferença deliberada em relação ao PIW-QOL é o tempo de inatividade: `2 minutos` em vez de `10 segundos`.

## Painel

O painel foi mantido propositalmente simples:

```text
🟢 CONECTADO
RECONEXÕES: 0
```

ou:

```text
🔴 DESCONECTADO
RECONEXÕES: 1
```

Ele pode ser arrastado e sua posição é salva localmente.

## Instalação para desenvolvimento

1. Abra `chrome://extensions` no Google Chrome.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione a pasta do projeto.
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

A extensão não possui analytics, chamadas externas próprias, coleta de cookies ou envio de credenciais. Ela atua somente sobre o JavaScript/WebSocket da página do Poke Idle World.

## Aviso

Este é um projeto independente e não é afiliado ao Poke Idle World nem ao PIW-QOL.

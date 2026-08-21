# PIW Auto Reconnect

Extensão do Google Chrome para o Poke Idle World focada exclusivamente em Auto Reconnect.

## Status

Versão atual: `0.8.2`

Projeto independente e ainda em testes.

## Como funciona

A lógica monitora o WebSocket do jogo e acompanha sinais de atividade da Hunt.

- identifica a Hunt pelo `enter-hunt` enviado pelo próprio jogo;
- acompanha mensagens de progresso e mudanças do capture bar;
- considera a Hunt potencialmente travada após `1 minuto` sem progresso;
- em uma Hunt travada, salva o slug por aba e executa `F5`;
- após o reload causado pela extensão, espera o novo WebSocket ficar disponível e envia `enter-hunt` com o mesmo slug;
- aguarda uma confirmação real de progresso antes de incrementar `RECONEXÕES`;
- se o WebSocket cair completamente, ainda permite uma janela de `45 segundos` para a reconexão normal do próprio jogo antes de usar o reload;
- um `F5` manual não cria uma recuperação automática, porque somente reloads marcados pela extensão ficam com `reconnectPending`.

## Painel

O painel é propositalmente simples:

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

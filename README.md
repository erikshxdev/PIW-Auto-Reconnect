# PIW Auto Reconnect

Extensão do Google Chrome para monitorar a conexão da Hunt no Poke Idle World e tentar recuperá-la automaticamente quando o WebSocket trava ou cai.

## Status

Versão atual: `0.6.0`

Projeto independente e ainda em fase de testes.

## O que a versão 0.6.0 faz

- Monitora o WebSocket usado pelo jogo.
- Usa apenas um conjunto de listeners por WebSocket, evitando duplicação de eventos ao longo da sessão.
- Identifica a Hunt pelo `enter-hunt` enviado pelo próprio jogo.
- Mantém o estado da Hunt por aba usando `sessionStorage`, evitando cruzamento entre contas em abas diferentes do mesmo perfil do Chrome.
- Considera a Hunt potencialmente travada somente após 2 minutos sem atividade relevante.
- Verifica o contexto visual real da Hunt antes de tentar uma recuperação; o Hunt Analyzer sozinho não é tratado como prova suficiente.
- Acompanha também mudanças do capture bar.
- Recupera a Hunt com `leave-hunt` seguido de `enter-hunt`, alinhado ao mecanismo atual do PIW-QOL, sem usar teleporte pelo mapa.
- Não conta uma reconexão apenas porque `enter-hunt` foi enviado: espera uma confirmação real de progresso da Hunt.
- Se a tentativa não for confirmada, evita repetir imediatamente a mesma recuperação.
- Detecta queda do WebSocket.
- Usa recarregamento da página como último recurso após uma queda prolongada.
- Mantém o estado necessário para tentar recuperar a Hunt depois do reload.
- Exibe o estado da conexão, o número de reconexões e o controle `AUTO RECONNECT: ON/OFF`.
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

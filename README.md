# PIW Auto Reconnect

Extensão do Google Chrome para monitorar a conexão da hunt no Poke Idle World e tentar recuperá-la automaticamente quando o WebSocket trava ou cai.

## Status

Versão atual: `0.4.0`

Projeto independente e ainda em fase de testes.

## O que a versão 0.4.0 faz

- Monitora o WebSocket usado pelo jogo.
- Identifica a hunt pelo `enter-hunt` enviado pelo próprio jogo.
- Guarda o `slug` da hunt localmente.
- Considera a hunt potencialmente travada somente após 2 minutos sem atividade relevante.
- Tenta recuperar a hunt com `leave-hunt` seguido de `enter-hunt`.
- Não conta uma reconexão como sucesso apenas porque `send()` funcionou: aguarda atividade real da hunt como confirmação.
- Detecta queda do WebSocket.
- Usa recarregamento da página como último recurso após uma queda prolongada.
- Mantém o estado necessário para tentar recuperar a hunt depois do reload.
- Exibe estado da conexão, número de reconexões e controle ON/OFF do Auto Reconnect.
- Permite arrastar o painel para qualquer posição da tela e salva a posição localmente.
- O ON/OFF pausa apenas as ações automáticas da extensão; não desativa a extensão nem recarrega a página.

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

# AssistTech - Sistema de Assistência Técnica

Aplicação web para gestão de assistência técnica de computadores, desenvolvida com Node.js, Express, EJS, Bootstrap e MongoDB. O sistema organiza clientes, ordens de serviço e componentes de estoque, com fluxo de orçamento, aprovação do cliente, acompanhamento do reparo e conclusão.

## Funcionalidades

- Dashboard com indicadores de clientes, manutenções por status e componentes cadastrados.
- Cadastro, edição, busca e exclusão de clientes.
- Abertura de ordens de manutenção por cliente e equipamento.
- Acompanhamento dos status: em análise, aguardando aprovação, orçamento aprovado, orçamento recusado, em reparo e concluído.
- Registro de diagnóstico técnico, observações, valor total e data de saída.
- Catálogo de componentes com categoria, estoque, preço e fornecedor.
- Associação de componentes utilizados em uma manutenção.
- Geração automática de número de ordem de serviço (ex.: `OS-2026-0001`).
- Baixa e devolução de estoque com validação de disponibilidade.
- Alertas de estoque baixo e faturamento de serviços concluídos no dashboard.
- Impressão das vias da empresa e do cliente para a ordem de serviço.
- Autenticação de usuários com senhas armazenadas como hash usando bcryptjs.
- Interface responsiva e padronizada para uso em desktop e celular.

## Tecnologias

- Node.js
- Express.js
- MongoDB
- Mongoose
- EJS
- Bootstrap 5
- bcryptjs
- express-session
- connect-mongo

## Estrutura principal

```text
controllers/      Regras das telas e operações do sistema
models/           Modelos Mongoose de Cliente, Manutencao, Componente e Usuario
routes/           Definição das rotas HTTP
views/            Templates EJS renderizados pelo Express
views/partials/   Cabeçalho e rodapé compartilhados
public/css/       Estilos próprios da aplicação
api/index.js      Entrada serverless para deploy na Vercel
index.js          Entrada HTTP usada localmente e no Render
```

## Como executar

1. Instale as dependências:

```bash
npm install
```

2. Crie seu arquivo local de variáveis a partir do exemplo:

```bash
cp .env.example .env
```

Edite `.env` e configure:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/manutencao_computadores
SESSION_SECRET=uma_chave_segura_para_sessao
PORT=3001
NODE_ENV=development
# Opcional localmente; em produção, use a URL pública do serviço.
PUBLIC_BASE_URL=http://localhost:3001
```

Não envie o arquivo `.env` ao Git. Em produção, use variáveis de ambiente configuradas na plataforma de hospedagem.

3. Inicie o projeto:

```bash
npm start
```

O sistema ficará disponível em `http://localhost:3001`. Para desenvolvimento com reinicialização automática, use `npm run dev`.

## Deploy no Render

Crie um **Web Service** conectado ao repositório e configure:

- **Build Command:** `npm install`
- **Start Command:** `npm start`

Em **Environment Variables**, configure:

- `MONGODB_URI`: URI de conexão do MongoDB Atlas.
- `SESSION_SECRET`: segredo forte e exclusivo para as sessões.
- `NODE_ENV`: `production`, para habilitar o cookie seguro de sessão.
- `PUBLIC_BASE_URL`: URL pública do serviço, por exemplo `https://seu-servico.onrender.com`, para gerar links de aprovação com o endereço correto.

O Render fornece a variável `PORT` para o serviço; não é necessário definir uma porta fixa no painel. No MongoDB Atlas, permita conexões de rede do Render. A aplicação lê essas configurações como variáveis de ambiente; não é necessário usar **Secret Files**.

## Rotas principais

- `/` - Dashboard (requer login; visitantes são encaminhados para `/auth/login`)
- `/site` - Página institucional (também requer login na configuração atual)
- `/cliente` - Gestão de clientes (requer login)
- `/manutencoes` - Gestão de ordens de serviço (requer login)
- `/componentes` - Gestão de componentes (requer login)
- `/auth/login` - Login
- `/auth/register` - Cadastro de usuário
- `/orcamentos/:token` - Consulta e decisão pública sobre um orçamento; o link também pode usar `/manutencoes/orcamento/:token`

## Regras de negócio importantes

- Os componentes e quantidades selecionados compõem o orçamento; eles não são baixados do estoque enquanto aguardam aprovação.
- A OS passa por análise e aprovação do orçamento. O cliente pode aprovar ou recusar por um link individual, válido por sete dias.
- O estoque é baixado na quantidade orçada quando uma OS aprovada passa para "Em reparo"; ao excluir uma OS com estoque baixado, as quantidades são devolvidas.
- Configure `PUBLIC_BASE_URL` com a URL pública da aplicação para gerar links de aprovação com o domínio desejado. Se não estiver configurada, a aplicação usa o protocolo e o host da requisição.
- Clientes e componentes vinculados a ordens de serviço não podem ser excluídos, preservando a rastreabilidade dos atendimentos.
- Ao concluir uma ordem, a data de saída é registrada automaticamente e o valor entra no faturamento exibido no painel.

## Observações para apresentação

Antes da demonstração, cadastre ao menos um usuário, alguns clientes, componentes e ordens de serviço. Isso permite que o dashboard apresente indicadores e que o fluxo de orçamento, aprovação, reparo e conclusão fique visível para a banca.

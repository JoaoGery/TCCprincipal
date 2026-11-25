import Manutencao from '../models/manutencao.js';
import Componente from '../models/componente.js';
import Cliente from '../models/cliente.js';
import Contador from '../models/contador.js';
import { isValidObjectId, parsePositiveNumber, sanitizeText } from '../utils/validators.js';
import { setFlash } from '../utils/flash.js';
import { createHash, randomBytes } from 'crypto';

const VALID_STATUSES = ['em_analise', 'aguardando_aprovacao', 'orcamento_aprovado', 'orcamento_recusado', 'em_reparo', 'concluido'];
const STATUS_LABELS = {
  em_analise: 'Em análise',
  aguardando_aprovacao: 'Aguardando aprovação',
  orcamento_aprovado: 'Orçamento aprovado',
  orcamento_recusado: 'Orçamento recusado',
  em_reparo: 'Em reparo',
  concluido: 'Concluído'
};

const nextServiceOrder = async () => {
  const year = new Date().getFullYear();
  const counter = await Contador.findOneAndUpdate(
    { chave: `ordem-servico-${year}` },
    { $inc: { sequencia: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return `OS-${year}-${String(counter.sequencia).padStart(4, '0')}`;
};

const normalizeComponentIds = (ids = []) => {
  const list = Array.isArray(ids) ? ids : [ids];
  return [...new Set(list.filter(Boolean).map(String))];
};

const normalizeComponentUsage = (ids = [], body = {}) => {
  return normalizeComponentIds(ids).map(id => {
    const rawQuantity = body?.[`quantidade-${id}`] ?? body?.quantidades?.[id] ?? 1;
    const quantidade = Math.floor(Number(rawQuantity));
    return {
      componente: id,
      quantidade: Number.isInteger(quantidade) && quantidade > 0 ? quantidade : 0
    };
  });
};

const getQuoteItems = async (componentIds = [], body = {}) => {
  if (!componentIds.every(isValidObjectId)) {
    throw stockError('Um dos componentes selecionados não é válido. Atualize a página e tente novamente.');
  }
  const usage = normalizeComponentUsage(componentIds, body);
  if (usage.some(item => item.quantidade < 1)) {
    throw stockError('Informe uma quantidade válida para cada componente do orçamento.');
  }

  if (!usage.length) return [];

  const components = await Componente.find({ _id: { $in: usage.map(item => item.componente) } }).lean();
  const byId = new Map(components.map(component => [String(component._id), component]));

  return usage.map(item => {
    const component = byId.get(item.componente);
    if (!component) throw stockError('Um dos componentes selecionados não foi encontrado. Atualize a página e tente novamente.');
    const rawPrice = body?.[`preco-${item.componente}`];
    const valorUnitario = rawPrice === undefined ? Number(component.precoUnitario || 0) : Number(rawPrice);
    const descricao = sanitizeText(body?.[`descricaoComponente-${item.componente}`], component.nome);
    if (!Number.isFinite(valorUnitario) || valorUnitario < 0) {
      throw stockError(`Informe um preço válido para ${component.nome}.`);
    }
    return {
      componente: component._id,
      descricao: descricao || component.nome,
      quantidade: item.quantidade,
      valorUnitario
    };
  });
};

const getQuoteTotal = (items = [], labor = 0) => items.reduce(
  (total, item) => total + Number(item.quantidade || 0) * Number(item.valorUnitario || 0),
  Number(labor || 0)
).toFixed(2) * 1;

const hasQuoteChanged = (previous = {}, items = [], labor = 0, customerDetails = {}) => {
  const previousItems = (previous.itensOrcamento || []).map(item => ({
    componente: String(item.componente?._id || item.componente),
    descricao: String(item.descricao || ''),
    quantidade: Number(item.quantidade || 0),
    valorUnitario: Number(item.valorUnitario || 0)
  }));
  const nextItems = items.map(item => ({
    componente: String(item.componente),
    descricao: String(item.descricao || ''),
    quantidade: Number(item.quantidade || 0),
    valorUnitario: Number(item.valorUnitario || 0)
  }));
  return JSON.stringify(previousItems) !== JSON.stringify(nextItems)
    || Number(previous.valorMaoDeObra || 0) !== Number(labor || 0)
    || ['marcaComputador', 'modeloComputador', 'descricaoProblema'].some(field =>
      String(previous[field] || '') !== String(customerDetails[field] || '')
    );
};

const getApprovalTokenHash = token => createHash('sha256').update(token).digest('hex');

const getPublicBaseUrl = req => {
  const configuredUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  const placeholderPattern = /^(?:https?:\/\/)?(?:url-real-do-servico|seu-dominio\.example)(?:\.onrender\.com)?(?:\/.*)?$/i;

  let baseUrl;
  if (configuredUrl && !placeholderPattern.test(configuredUrl)) {
    baseUrl = configuredUrl;
  } else {
    baseUrl = `${req.protocol}://${req.get('host')}`;
  }

  const parsedUrl = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('PUBLIC_BASE_URL precisa usar HTTP ou HTTPS.');
  }
  return parsedUrl.origin;
};

const getStoredComponentUsage = (manutencao = {}) => {
  if (Array.isArray(manutencao.componentesUsados)) {
    const stored = manutencao.componentesUsados.map(item => ({
      componente: String(item.componente?._id || item.componente),
      quantidade: Math.max(1, Math.floor(Number(item.quantidade || 1)))
    })).filter(item => item.componente && item.componente !== 'undefined');
    if (stored.length || manutencao.estoqueBaixado === false) return stored;
  }

  return normalizeComponentIds(manutencao.componentes || []).map(id => ({ componente: id, quantidade: 1 }));
};

const getUsageStockDiff = (previousUsage = [], nextUsage = []) => {
  const previousMap = new Map(previousUsage.map(item => [item.componente, item.quantidade]));
  const nextMap = new Map(nextUsage.map(item => [item.componente, item.quantidade]));
  const differences = [];

  for (const [id, quantity] of nextMap) {
    const difference = quantity - (previousMap.get(id) || 0);
    if (difference !== 0) differences.push({ componente: id, quantidade: difference });
  }
  for (const [id, quantity] of previousMap) {
    if (!nextMap.has(id)) differences.push({ componente: id, quantidade: -quantity });
  }

  return differences;
};

const stockError = (message) => {
  const error = new Error(message);
  error.name = 'StockError';
  return error;
};

const reserveComponentUsage = async (usage = []) => {
  const reserved = [];

  for (const item of usage) {
    const component = await Componente.findById(item.componente).select('nome quantidadeDisponivel').lean();
    if (!component) {
      await releaseComponentUsage(reserved);
      throw stockError('Um dos componentes selecionados não foi encontrado. Atualize a página e tente novamente.');
    }

    const result = await Componente.updateOne(
      { _id: item.componente, quantidadeDisponivel: { $gte: item.quantidade } },
      { $inc: { quantidadeDisponivel: -item.quantidade } }
    );

    if (!result.modifiedCount) {
      await releaseComponentUsage(reserved);
      throw stockError(`Não há estoque suficiente para ${component.nome}. Disponível: ${component.quantidadeDisponivel || 0}; solicitado: ${item.quantidade}.`);
    }

    reserved.push(item);
  }
};

const releaseComponentUsage = async (usage = []) => {
  for (const item of usage) {
    await Componente.updateOne(
      { _id: item.componente },
      { $inc: { quantidadeDisponivel: item.quantidade } }
    );
  }
};

const adjustStockForUsageDiff = async (differences = []) => {
  const reserved = [];
  const additions = differences.filter(item => item.quantidade > 0);
  const returns = differences.filter(item => item.quantidade < 0);

  try {
    for (const item of additions) {
      await reserveComponentUsage([{ componente: item.componente, quantidade: item.quantidade }]);
      reserved.push(item);
    }
  } catch (error) {
    await releaseComponentUsage(reserved);
    throw error;
  }

  for (const item of returns) {
    await releaseComponentUsage([{ componente: item.componente, quantidade: Math.abs(item.quantidade) }]);
  }

  return reserved;
};

const getWhatsAppNumber = (phone = '') => {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return null;
};

const buildCustomerMessage = (manutencao) => {
  const nome = manutencao.cliente?.nome || 'cliente';
  const equipamento = [manutencao.marcaComputador, manutencao.modeloComputador].filter(Boolean).join(' ');

  return [
    `Olá, ${nome}! Temos uma atualização sobre sua manutenção na AssistTech.`,
    '',
    `Ordem de serviço: ${manutencao.numeroOrdem || 'Não informada'}`,
    `Equipamento: ${equipamento || 'Não informado'}`,
    `Status atual: ${STATUS_LABELS[manutencao.status] || 'Não informado'}`,
    '',
    'Estamos à disposição para esclarecer qualquer dúvida.'
  ].join('\n');
};

const renderMaintenanceForm = async (res, statusCode, manutencao, error) => {
  const [clientes, componentes] = await Promise.all([
    Cliente.find().sort({ nome: 1 }).lean(),
    Componente.find().sort({ nome: 1 }).lean()
  ]);

  return res.status(statusCode).render('manutencao/form', {
    manutencao,
    clientes,
    componentes,
    error
  });
};

export const list = async (req, res) => {
  try {
    const status = sanitizeText(req.query.status);
    const q = sanitizeText(req.query.q);
    const filtro = {};

    if (VALID_STATUSES.includes(status)) {
      filtro.status = status;
    }

    if (q) {
      const clientesEncontrados = await Cliente.find({
        nome: { $regex: q, $options: 'i' }
      }).select('_id').lean();

      filtro.$or = [
        { numeroOrdem: { $regex: q, $options: 'i' } },
        { marcaComputador: { $regex: q, $options: 'i' } },
        { modeloComputador: { $regex: q, $options: 'i' } },
        { descricaoProblema: { $regex: q, $options: 'i' } },
        { cliente: { $in: clientesEncontrados.map(cliente => cliente._id) } }
      ];
    }

    const manutencoes = await Manutencao.find(filtro)
      .populate('cliente componentes')
      .sort({ dataEntrada: -1 })
      .lean();

    res.render('manutencao/list', { manutencoes, q, status });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao listar manutenções');
  }
};

export const view = async (req, res) => {
  try {
    const manutencao = await Manutencao.findById(req.params.id)
      .select('+tokenAprovacaoHash +codigoAprovacao')
      .populate('cliente componentes componentesUsados.componente itensOrcamento.componente')
      .lean();
    if (!manutencao) return res.status(404).send('Manutenção não encontrada');
    const shareToken = manutencao.codigoAprovacao
      && manutencao.status === 'aguardando_aprovacao'
      && manutencao.tokenAprovacaoExpiraEm > new Date()
      && getApprovalTokenHash(manutencao.codigoAprovacao) === manutencao.tokenAprovacaoHash
      ? manutencao.codigoAprovacao
      : null;
    delete manutencao.tokenAprovacaoHash;
    delete manutencao.codigoAprovacao;
    const approvalUrl = shareToken
      ? `${getPublicBaseUrl(req)}/orcamentos/${shareToken}`
      : null;
    const quoteMessage = approvalUrl
      ? `Olá, ${manutencao.cliente?.nome || 'cliente'}! O orçamento da OS ${manutencao.numeroOrdem} está pronto. Consulte os serviços, valores e aprove ou recuse neste link: ${approvalUrl}`
      : null;
    const mensagemCliente = buildCustomerMessage(manutencao);
    const whatsappNumber = getWhatsAppNumber(manutencao.cliente?.telefone);
    const whatsappUrl = whatsappNumber
      ? `https://wa.me/${whatsappNumber}?${new URLSearchParams({ text: mensagemCliente })}`
      : null;
    const gmailUrl = manutencao.cliente?.email
      ? `https://mail.google.com/mail/?${new URLSearchParams({
          view: 'cm',
          fs: '1',
          to: manutencao.cliente.email,
          su: `Atualização da manutenção ${manutencao.numeroOrdem || ''}`.trim(),
          body: mensagemCliente
        })}`
      : null;
    const quoteWhatsappUrl = whatsappNumber && quoteMessage
      ? `https://wa.me/${whatsappNumber}?${new URLSearchParams({ text: quoteMessage })}`
      : null;
    const quoteGmailUrl = manutencao.cliente?.email && quoteMessage
      ? `https://mail.google.com/mail/?${new URLSearchParams({
          view: 'cm', fs: '1', to: manutencao.cliente.email,
          su: `Orçamento da OS ${manutencao.numeroOrdem || ''}`.trim(), body: quoteMessage
        })}`
      : null;
    res.render('manutencao/view', {
      manutencao, mensagemCliente, whatsappUrl, gmailUrl,
      approvalUrl, quoteWhatsappUrl, quoteGmailUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao buscar manutenção');
  }
};

export const generateApprovalLink = async (req, res) => {
  try {
    const baseUrl = getPublicBaseUrl(req);
    const manutencao = await Manutencao.findById(req.params.id).populate('cliente').lean();
    if (!manutencao) return res.status(404).send('Ordem de serviço não encontrada.');
    if (['em_reparo', 'concluido'].includes(manutencao.status)) {
      setFlash(req, 'error', 'O orçamento não pode ser reenviado depois que o reparo começou.');
      return res.redirect(`/manutencoes/${manutencao._id}`);
    }

    const token = randomBytes(32).toString('hex');
    const tokenAprovacaoHash = getApprovalTokenHash(token);
    const tokenAprovacaoExpiraEm = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const itensOrcamento = manutencao.itensOrcamento || [];
    const valorMaoDeObra = !itensOrcamento.length && Number(manutencao.valorTotal || 0) > Number(manutencao.valorMaoDeObra || 0)
      ? Number(manutencao.valorTotal)
      : Number(manutencao.valorMaoDeObra || 0);
    const valorTotal = itensOrcamento.length
      ? getQuoteTotal(itensOrcamento, valorMaoDeObra)
      : Number(manutencao.valorTotal || valorMaoDeObra);

    await Manutencao.updateOne({ _id: manutencao._id }, {
      $set: {
        status: 'aguardando_aprovacao',
        valorMaoDeObra,
        valorTotal,
        tokenAprovacaoHash,
        codigoAprovacao: token,
        tokenAprovacaoExpiraEm,
        aprovadoEm: null,
        recusadoEm: null
      }
    });

    setFlash(req, 'success', 'Link do orçamento criado. Envie-o ao cliente pelo WhatsApp ou Gmail. O link expira em 7 dias.');
    return res.redirect(`/manutencoes/${manutencao._id}`);
  } catch (err) {
    console.error(err);
    if (err.message?.includes('PUBLIC_BASE_URL')) {
      setFlash(req, 'warning', err.message);
      return res.redirect(`/manutencoes/${req.params.id}`);
    }
    res.status(500).send('Não foi possível gerar o link do orçamento.');
  }
};

export const publicQuote = async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(404).render('error', {
      statusCode: 404,
      title: 'Link inválido',
      message: 'Este link de orçamento não é válido.'
    });
  }

  try {
    const tokenHash = getApprovalTokenHash(token);
    const manutencao = await Manutencao.findOne({
      $or: [
        { codigoAprovacao: token, tokenAprovacaoHash: tokenHash },
        { tokenAprovacaoHash: tokenHash }
      ]
    })
      .populate('cliente itensOrcamento.componente')
      .lean();
    if (!manutencao) {
      return res.status(404).render('error', {
        statusCode: 404,
        title: 'Link não encontrado',
        message: 'O link do orçamento não existe ou foi substituído por outro.'
      });
    }

    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const expirado = !manutencao.tokenAprovacaoExpiraEm || manutencao.tokenAprovacaoExpiraEm < new Date();
    res.render('manutencao/orcamento-publico', { manutencao, expirado, token });
  } catch (err) {
    console.error(err);
    res.status(500).send('Não foi possível abrir o orçamento.');
  }
};

export const decidePublicQuote = async (req, res) => {
  const token = String(req.params.token || '');
  const decision = sanitizeText(req.body.decisao);
  if (!/^[a-f0-9]{64}$/i.test(token) || !['aprovar', 'recusar'].includes(decision)) {
    return res.status(400).send('Solicitação de aprovação inválida.');
  }

  try {
    const tokenAprovacaoHash = getApprovalTokenHash(token);
    const manutencao = await Manutencao.findOne({
      $or: [
        { codigoAprovacao: token, tokenAprovacaoHash },
        { tokenAprovacaoHash }
      ],
      status: 'aguardando_aprovacao',
      tokenAprovacaoExpiraEm: { $gt: new Date() }
    }).select('_id').lean();

    if (!manutencao) return res.redirect(`/orcamentos/${token}`);

    const aprovado = decision === 'aprovar';
    await Manutencao.updateOne({
      _id: manutencao._id,
      tokenAprovacaoHash,
      status: 'aguardando_aprovacao',
      tokenAprovacaoExpiraEm: { $gt: new Date() }
    }, {
      $set: {
        status: aprovado ? 'orcamento_aprovado' : 'orcamento_recusado',
        aprovadoEm: aprovado ? new Date() : null,
        recusadoEm: aprovado ? null : new Date()
      }
    });
    return res.redirect(`/orcamentos/${token}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Não foi possível registrar a decisão.');
  }
};

export const formCreate = async (req, res) => {
  try {
    const [clientes, componentes] = await Promise.all([
      Cliente.find().sort({ nome: 1 }).lean(),
      Componente.find().sort({ nome: 1 }).lean()
    ]);
    res.render('manutencao/form', { manutencao: {}, clientes, componentes, error: null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao abrir formulário de manutenção');
  }
};

export const create = async (req, res) => {
  try {
    const clienteId = String(req.body.cliente || '');
    const marcaComputador = sanitizeText(req.body.marcaComputador);
    const modeloComputador = sanitizeText(req.body.modeloComputador);
    const descricaoProblema = sanitizeText(req.body.descricaoProblema);
    const componentes = normalizeComponentIds(req.body.componentes);
    const itensOrcamento = await getQuoteItems(componentes, req.body);
    const valorMaoDeObra = parsePositiveNumber(req.body.valorMaoDeObra);
    const valorTotal = getQuoteTotal(itensOrcamento, valorMaoDeObra);

    if (!isValidObjectId(clienteId) || !marcaComputador || !modeloComputador || !descricaoProblema || !componentes.every(isValidObjectId)) {
      return renderMaintenanceForm(
        res,
        400,
        { cliente: clienteId, marcaComputador, modeloComputador, descricaoProblema, componentes, itensOrcamento, valorMaoDeObra, valorTotal },
        'Selecione um cliente e informe os dados do equipamento e do problema.'
      );
    }

    const cliente = await Cliente.exists({ _id: clienteId });
    if (!cliente) {
      return renderMaintenanceForm(res, 400, { cliente: clienteId, marcaComputador, modeloComputador, descricaoProblema, componentes, itensOrcamento, valorMaoDeObra, valorTotal }, 'O cliente selecionado não existe mais.');
    }

    const numeroOrdem = await nextServiceOrder();
    const manutencaoCriada = await Manutencao.create({
      numeroOrdem,
      cliente: clienteId,
      marcaComputador,
      modeloComputador,
      descricaoProblema,
      componentes,
      itensOrcamento,
      componentesUsados: [],
      valorMaoDeObra,
      valorTotal,
      estoqueBaixado: false,
      status: 'em_analise'
    });

    const prepararEnvio = req.body.prepararEnvio === 'on';
    setFlash(
      req,
      'success',
      prepararEnvio
        ? 'Ordem de serviço aberta. Escolha um canal abaixo para revisar e enviar a mensagem ao cliente.'
        : 'Ordem de serviço aberta com sucesso.'
    );
    if (prepararEnvio) return res.redirect(`/manutencoes/${manutencaoCriada._id}`);
    return res.redirect(`/manutencoes/${manutencaoCriada._id}`);
  } catch (err) {
    console.error(err);
    if (err.name === 'StockError') {
      return renderMaintenanceForm(
        res,
        400,
        {
          cliente: req.body.cliente,
          marcaComputador: req.body.marcaComputador,
          modeloComputador: req.body.modeloComputador,
          descricaoProblema: req.body.descricaoProblema,
          componentes: normalizeComponentIds(req.body.componentes),
          itensOrcamento: normalizeComponentUsage(req.body.componentes, req.body).map(item => ({
            componente: item.componente,
            quantidade: item.quantidade,
            valorUnitario: Number(req.body[`preco-${item.componente}`] ?? 0),
            descricao: sanitizeText(req.body[`descricaoComponente-${item.componente}`])
          })),
          valorMaoDeObra: parsePositiveNumber(req.body.valorMaoDeObra)
        },
        err.message
      );
    }
    res.status(500).send('Erro ao criar manutenção');
  }
};

export const formEdit = async (req, res) => {
  try {
    const [manutencao, clientes, componentes] = await Promise.all([
      Manutencao.findById(req.params.id).lean(),
      Cliente.find().sort({ nome: 1 }).lean(),
      Componente.find().sort({ nome: 1 }).lean()
    ]);
    
    if (!manutencao) return res.status(404).send('Manutenção não encontrada');
    res.render('manutencao/form', { manutencao, clientes, componentes, error: null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao abrir edição');
  }
};

export const update = async (req, res) => {
  try {
    const cliente = String(req.body.cliente || '');
    const status = sanitizeText(req.body.status);
    const componentes = normalizeComponentIds(req.body.componentes);
    const itensOrcamento = await getQuoteItems(componentes, req.body);
    const valorMaoDeObra = parsePositiveNumber(req.body.valorMaoDeObra);
    const valorTotal = getQuoteTotal(itensOrcamento, valorMaoDeObra);
    const manutencaoAtual = await Manutencao.findById(req.params.id).lean();

    if (!manutencaoAtual) return res.status(404).send('Manutenção não encontrada');
    
    const update = {
      cliente,
      marcaComputador: sanitizeText(req.body.marcaComputador),
      modeloComputador: sanitizeText(req.body.modeloComputador),
      descricaoProblema: sanitizeText(req.body.descricaoProblema),
      diagnosticoTecnico: sanitizeText(req.body.diagnosticoTecnico),
      status,
      componentes,
      itensOrcamento,
      valorMaoDeObra,
      valorTotal,
      observacoes: sanitizeText(req.body.observacoes)
    };
    const quoteChanged = hasQuoteChanged(manutencaoAtual, itensOrcamento, valorMaoDeObra, update);

    if (!isValidObjectId(update.cliente) || !update.marcaComputador || !update.modeloComputador || !update.descricaoProblema || !VALID_STATUSES.includes(status) || !componentes.every(isValidObjectId)) {
      return renderMaintenanceForm(
        res,
        400,
        { ...manutencaoAtual, ...update, _id: req.params.id },
        'Selecione um cliente e informe os dados do equipamento e do problema.'
      );
    }

    const unset = {};

    if (status === 'concluido' && manutencaoAtual.status !== 'concluido') {
      update.dataSaida = new Date();
    } else {
      unset.dataSaida = '';
    }

    Object.keys(update).forEach(k => update[k] === undefined && delete update[k]);

    const clienteExiste = await Cliente.exists({ _id: update.cliente });
    if (!clienteExiste) {
      return renderMaintenanceForm(res, 400, { ...manutencaoAtual, ...update, _id: req.params.id }, 'O cliente selecionado não existe mais.');
    }

    const isRepairStarted = manutencaoAtual.status === 'em_reparo' || manutencaoAtual.status === 'concluido';
    if (status === 'em_reparo' && manutencaoAtual.status !== 'em_reparo' && manutencaoAtual.status !== 'orcamento_aprovado') {
      return renderMaintenanceForm(res, 400, { ...manutencaoAtual, ...update, _id: req.params.id }, 'O cliente precisa aprovar o orçamento antes de iniciar o reparo.');
    }
    if (isRepairStarted && !['em_reparo', 'concluido'].includes(status)) {
      return renderMaintenanceForm(res, 400, { ...manutencaoAtual, ...update, _id: req.params.id }, 'Uma OS com reparo iniciado não pode voltar para aprovação ou análise.');
    }
    if (status === 'concluido' && !['em_reparo', 'concluido'].includes(manutencaoAtual.status)) {
      return renderMaintenanceForm(res, 400, { ...manutencaoAtual, ...update, _id: req.params.id }, 'Inicie o reparo após a aprovação antes de concluir a OS.');
    }
    if (['aguardando_aprovacao', 'orcamento_aprovado', 'orcamento_recusado'].includes(status) && status !== manutencaoAtual.status) {
      return renderMaintenanceForm(res, 400, { ...manutencaoAtual, ...update, _id: req.params.id }, 'A situação da aprovação é atualizada pelo fluxo do orçamento.');
    }

    const previousUsage = getStoredComponentUsage(manutencaoAtual);
    const nextUsage = itensOrcamento.map(item => ({ componente: String(item.componente), quantidade: item.quantidade }));
    const shouldDeductStock = status === 'em_reparo' || status === 'concluido';
    const legacyStockWasDeducted = manutencaoAtual.estoqueBaixado === undefined;
    const stockWasDeducted = manutencaoAtual.estoqueBaixado === true || legacyStockWasDeducted;
    const stockDiff = shouldDeductStock && stockWasDeducted
      ? getUsageStockDiff(previousUsage, nextUsage)
      : shouldDeductStock
        ? nextUsage
        : [];

    if (stockDiff.length) await adjustStockForUsageDiff(stockDiff);
    update.componentesUsados = shouldDeductStock
      ? nextUsage.map(item => ({ componente: item.componente, quantidade: item.quantidade }))
      : manutencaoAtual.componentesUsados || [];
    update.estoqueBaixado = shouldDeductStock || stockWasDeducted;
    const invalidatesApproval = quoteChanged && ['aguardando_aprovacao', 'orcamento_aprovado', 'orcamento_recusado'].includes(manutencaoAtual.status);
    if (invalidatesApproval) {
      update.status = 'em_analise';
      update.aprovadoEm = null;
      update.recusadoEm = null;
      update.tokenAprovacaoHash = null;
      update.tokenAprovacaoExpiraEm = null;
    }
    try {
      await Manutencao.findByIdAndUpdate(req.params.id, Object.keys(unset).length ? { $set: update, $unset: unset } : { $set: update }, { runValidators: true });
    } catch (error) {
      if (stockDiff.length) await adjustStockForUsageDiff(stockDiff.map(item => ({ ...item, quantidade: -item.quantidade })));
      throw error;
    }
    setFlash(req, 'success', invalidatesApproval
      ? 'Ordem atualizada. O orçamento mudou, então o link anterior foi invalidado; gere e envie um novo link.'
      : 'Ordem de serviço atualizada.');
    return res.redirect(`/manutencoes/${req.params.id}`);
  } catch (err) {
    console.error(err);
    if (err.name === 'StockError') {
      return renderMaintenanceForm(
        res,
        400,
        {
          ...req.body,
          _id: req.params.id,
          componentes: normalizeComponentIds(req.body.componentes),
          itensOrcamento: normalizeComponentUsage(req.body.componentes, req.body).map(item => ({
            componente: item.componente,
            quantidade: item.quantidade,
            valorUnitario: Number(req.body[`preco-${item.componente}`] ?? 0),
            descricao: sanitizeText(req.body[`descricaoComponente-${item.componente}`])
          }))
        },
        err.message
      );
    }
    res.status(500).send('Erro ao atualizar manutenção');
  }
};

export const remove = async (req, res) => {
  try {
    const manutencao = await Manutencao.findById(req.params.id).lean();

    if (manutencao) {
      if (manutencao.estoqueBaixado === true || manutencao.estoqueBaixado === undefined) {
        await releaseComponentUsage(getStoredComponentUsage(manutencao));
      }
      await Manutencao.findByIdAndDelete(req.params.id);
      setFlash(req, 'success', 'Ordem de serviço excluída e componentes devolvidos ao estoque.');
    }

    res.redirect('/manutencoes');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao excluir manutenção');
  }
};

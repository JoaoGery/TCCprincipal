import Manutencao from '../models/manutencao.js';
import Componente from '../models/componente.js';
import Cliente from '../models/cliente.js';
import Contador from '../models/contador.js';
import { isValidObjectId, parsePositiveNumber, sanitizeText } from '../utils/validators.js';
import { setFlash } from '../utils/flash.js';

const VALID_STATUSES = ['em_analise', 'em_reparo', 'concluido'];
const STATUS_LABELS = {
  em_analise: 'Em análise',
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

const getStoredComponentUsage = (manutencao = {}) => {
  if (Array.isArray(manutencao.componentesUsados) && manutencao.componentesUsados.length) {
    return manutencao.componentesUsados.map(item => ({
      componente: String(item.componente?._id || item.componente),
      quantidade: Math.max(1, Math.floor(Number(item.quantidade || 1)))
    })).filter(item => item.componente && item.componente !== 'undefined');
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

  try {
    for (const difference of differences) {
      if (difference.quantidade > 0) {
        await reserveComponentUsage([{ componente: difference.componente, quantidade: difference.quantidade }]);
        reserved.push({ componente: difference.componente, quantidade: difference.quantidade });
      } else {
        await releaseComponentUsage([{ componente: difference.componente, quantidade: Math.abs(difference.quantidade) }]);
      }
    }
  } catch (error) {
    await releaseComponentUsage(reserved);
    throw error;
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

    if (['em_analise', 'em_reparo', 'concluido'].includes(status)) {
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
    const manutencao = await Manutencao.findById(req.params.id).populate('cliente componentes componentesUsados.componente').lean();
    if (!manutencao) return res.status(404).send('Manutenção não encontrada');
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
    res.render('manutencao/view', { manutencao, mensagemCliente, whatsappUrl, gmailUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao buscar manutenção');
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
    const componentesUsados = normalizeComponentUsage(req.body.componentes, req.body);

    if (!isValidObjectId(clienteId) || !marcaComputador || !modeloComputador || !descricaoProblema || !componentes.every(isValidObjectId) || componentesUsados.some(item => item.quantidade < 1)) {
      return renderMaintenanceForm(
        res,
        400,
        { cliente: clienteId, marcaComputador, modeloComputador, descricaoProblema, componentes },
        'Selecione um cliente e informe os dados do equipamento e do problema.'
      );
    }

    const cliente = await Cliente.exists({ _id: clienteId });
    if (!cliente) {
      return renderMaintenanceForm(res, 400, { cliente: clienteId, marcaComputador, modeloComputador, descricaoProblema, componentes }, 'O cliente selecionado não existe mais.');
    }

    await reserveComponentUsage(componentesUsados);
    let manutencaoCriada;
    try {
      const numeroOrdem = await nextServiceOrder();
      manutencaoCriada = await Manutencao.create({ numeroOrdem, cliente: clienteId, marcaComputador, modeloComputador, descricaoProblema, componentes, componentesUsados, status: 'em_analise' });
    } catch (error) {
      await releaseComponentUsage(componentesUsados);
      throw error;
    }

    const prepararEnvio = req.body.prepararEnvio === 'on';
    setFlash(
      req,
      'success',
      prepararEnvio
        ? 'Ordem de serviço aberta. Escolha um canal abaixo para revisar e enviar a mensagem ao cliente.'
        : 'Ordem de serviço aberta com sucesso.'
    );
    if (prepararEnvio) return res.redirect(`/manutencoes/${manutencaoCriada._id}`);
    return res.redirect('/manutencoes');
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
          componentes: normalizeComponentIds(req.body.componentes)
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
    const componentesUsados = normalizeComponentUsage(req.body.componentes, req.body);
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
      componentesUsados,
      valorTotal: parsePositiveNumber(req.body.valorTotal),
      observacoes: sanitizeText(req.body.observacoes)
    };

    if (!isValidObjectId(update.cliente) || !update.marcaComputador || !update.modeloComputador || !update.descricaoProblema || !VALID_STATUSES.includes(status) || !componentes.every(isValidObjectId) || componentesUsados.some(item => item.quantidade < 1)) {
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

    const previousUsage = getStoredComponentUsage(manutencaoAtual);
    const stockDiff = getUsageStockDiff(previousUsage, componentesUsados);
    await adjustStockForUsageDiff(stockDiff);
    try {
      await Manutencao.findByIdAndUpdate(req.params.id, Object.keys(unset).length ? { $set: update, $unset: unset } : { $set: update }, { runValidators: true });
    } catch (error) {
      await adjustStockForUsageDiff(stockDiff.map(item => ({ ...item, quantidade: -item.quantidade })));
      throw error;
    }
    setFlash(req, 'success', 'Ordem de serviço atualizada.');
    return res.redirect('/manutencoes');
  } catch (err) {
    console.error(err);
    if (err.name === 'StockError') {
      return renderMaintenanceForm(
        res,
        400,
        { ...req.body, _id: req.params.id, componentes: normalizeComponentIds(req.body.componentes) },
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
      await releaseComponentUsage(getStoredComponentUsage(manutencao));
      await Manutencao.findByIdAndDelete(req.params.id);
      setFlash(req, 'success', 'Ordem de serviço excluída e componentes devolvidos ao estoque.');
    }

    res.redirect('/manutencoes');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao excluir manutenção');
  }
};

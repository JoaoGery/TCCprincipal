import mongoose from 'mongoose';

const ManutencaoSchema = new mongoose.Schema({
  numeroOrdem: { type: String, unique: true, sparse: true, trim: true },
  cliente: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente', required: true },
  marcaComputador: { type: String, required: true, trim: true },
  modeloComputador: { type: String, required: true, trim: true },
  descricaoProblema: { type: String, required: true, trim: true },
  diagnosticoTecnico: { type: String, trim: true },
  dataEntrada: { type: Date, default: Date.now },
  dataSaida: { type: Date },
  status: { 
    type: String, 
    enum: ['em_analise', 'aguardando_aprovacao', 'orcamento_aprovado', 'orcamento_recusado', 'em_reparo', 'concluido'],
    default: 'em_analise' 
  },
  itensOrcamento: [{
    componente: { type: mongoose.Schema.Types.ObjectId, ref: 'Componente' },
    descricao: { type: String, required: true, trim: true },
    quantidade: { type: Number, required: true, min: 1, default: 1 },
    valorUnitario: { type: Number, required: true, min: 0, default: 0 }
  }],
  valorMaoDeObra: { type: Number, default: 0, min: 0 },
  tokenAprovacaoHash: { type: String, select: false },
  codigoAprovacao: { type: String, select: false },
  tokenAprovacaoExpiraEm: { type: Date },
  aprovadoEm: { type: Date },
  recusadoEm: { type: Date },
  estoqueBaixado: { type: Boolean },
  componentes: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Componente' 
  }],
  componentesUsados: [{
    componente: { type: mongoose.Schema.Types.ObjectId, ref: 'Componente', required: true },
    quantidade: { type: Number, required: true, min: 1, default: 1 }
  }],
  valorTotal: { type: Number, default: 0, min: 0 },
  observacoes: { type: String, trim: true }
}, { timestamps: true });

export default mongoose.model('Manutencao', ManutencaoSchema);

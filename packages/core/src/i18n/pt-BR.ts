import type { Frase } from './motor.js';

/**
 * O catálogo em português — e, por ser o primeiro, a FORMA do catálogo.
 *
 * As chaves saem daqui por `keyof`, então `en` e `es` não compilam com chave
 * faltando, sobrando ou escrita errado. Acrescentar uma frase é acrescentar
 * nos três, e o typecheck cobra.
 *
 * O que NÃO está aqui, de propósito: os nomes dos temas (são nomes próprios
 * de outra gente), `background-opacity`/`background-blur`/`wallpaper` e
 * `login:`/`password:` — esses já eram inglês dentro de uma interface em
 * português, porque pertencem ao registro de arquivo de configuração, não à
 * prosa. Os glifos `[x]`, `[ ]`, `[pro]`, `[off]`, `[meu]` também ficam de
 * fora: são marcas, não palavras.
 *
 * Os nomes de comando e de caminho (`ondas trending`, `~/em-alta`) ESTÃO
 * aqui, ao contrário do que o instinto diz. Eles são a interface para quem lê
 * a tela, e um app em inglês que diz `~/em-alta` só parece quebrado.
 */
export const PT_BR = {
  // ── a casca do terminal ──────────────────────────────────────
  'cwd.home': '~/em-alta',
  'cwd.search': '~/buscar',
  'cwd.library': '~/biblioteca',
  'cwd.changelog': '~/notas',
  'who.visitante': 'visitante',

  'cmd.trending': 'ondas trending --{flag}={genero}',
  'cmd.search': 'ondas search',
  'cmd.ls': 'ondas ls --{recorte}',
  'cmd.lsPlaylist': 'ondas ls --playlist="{nome}"',
  'cmd.changelog': 'ondas --changelog',

  // Os recortes da biblioteca, como aparecem no chip e no comando.
  'recorte.liked': 'curtidas',
  'recorte.playlists': 'playlists',
  'recorte.acervo': 'acervo',
  'recorte.shared': 'compartilhadas',
  'recorte.offline': 'offline',
  'genero.flag': 'genero',
  'genero.tudo': 'tudo',

  // ── o comentário do prompt ───────────────────────────────────
  'prompt.resultados': { one: '{n} resultado', other: '{n} resultados' },
  'prompt.sugestoes': 'sugestões — digite para filtrar',
  'prompt.itens': { one: '{n} item', other: '{n} itens' },
  'prompt.playlists': { one: '{n} playlist', other: '{n} playlists' },
  'prompt.foraDaLista': '{n} fora da lista',
  'prompt.faixas': { one: '{n} faixa', other: '{n} faixas' },
  'prompt.fonte': 'fonte: {fonte}',
  'prompt.fonteDesconhecida': '…',
  'prompt.maisAcervo': '+ acervo ({n})',
  'prompt.atualizando': 'atualizando',
  'prompt.changelog': { one: '{n} versão entregue', other: '{n} versões entregues' },

  // ── de onde veio a lista ─────────────────────────────────────
  'fonte.audius': 'audius api (ao vivo)',
  'fonte.cache': 'metadados em cache local',
  'fonte.demo-offline': 'catálogo demo — api inacessível',
  'fonte.demo': 'catálogo demo',
  'fonte.acervo': 'só o acervo',

  // ── listas vazias ────────────────────────────────────────────
  // Várias destas NOMEIAM um botão. O nome entra como parâmetro e nunca
  // digitado aqui: senão os três idiomas descolam do botão que descrevem.
  'vazio.busca': 'grep: nenhum resultado para "{termo}"',
  'vazio.publicoDesligado': {
    one: '{n} faixa aqui vem do catálogo público, que está desligado — religue em [{janelaConta}].',
    other:
      '{n} faixas aqui vêm do catálogo público, que está desligado — religue em [{janelaConta}].',
  },
  'vazio.curtidas': 'vazio — pressione [l] ou o coração para curtir.',
  'vazio.curtidasSemConta': 'curtidas exigem login.',
  'vazio.acervo': 'vazio — envie um arquivo com [{botaoArquivo}].',
  'vazio.acervoSemConta': 'o acervo exige login.',
  'vazio.playlistsSemConta': 'playlists exigem login.',
  'vazio.playlistDecaida': {
    one: '{n} faixa desta playlist não está no catálogo de hoje — faixa pública sai de {home} com o tempo; a do acervo fica.',
    other:
      '{n} faixas desta playlist não estão no catálogo de hoje — faixa pública sai de {home} com o tempo; a do acervo fica.',
  },
  'vazio.playlistAberta':
    'vazio — segure uma faixa na lista (ou tecle v) para marcar, e use [{botaoPlaylist}].',
  'vazio.nenhumaPlaylist':
    'nenhuma playlist — segure uma faixa na lista (ou tecle v) para marcar, e crie a primeira.',
  'vazio.compartilhadas': 'vazio — ninguém compartilhou faixa com você ainda.',
  'vazio.compartilhadasSemConta': 'compartilhadas exigem login.',
  'vazio.offline': 'vazio — baixe faixas [d] ou ative o buffer para ouvir sem rede.',
  'vazio.offlineSemConta': 'downloads offline exigem login.',
  'vazio.acervoNaHome': 'o acervo está vazio — envie um arquivo em {biblioteca}.',
  'vazio.nenhumaFaixa': 'nenhuma faixa.',

  // ── buffer e espaço ──────────────────────────────────────────
  'buffer.local': 'arquivo local — toca sem rede',
  'buffer.baixando': 'baixando {pct}% → disponível offline',
  'buffer.stream': 'stream · {tempo} em buffer à frente',
  'buffer.previa': 'prévia · {tempo} em buffer à frente',
  'buffer.curtoLocal': 'buf: local',
  'buffer.curtoAdiante': 'buf: +{tempo}',

  'espaco.calculando': 'calculando…',
  'espaco.semLimite': '{usado} usados · o navegador não informa o limite',
  'espaco.livres': '{livres} livres de {total}',

  // ── conta ────────────────────────────────────────────────────
  'plano.gratis': 'somente faixas grátis',
  'plano.acervo': 'acervo + offline',
  'plano.completo': 'catálogo completo + offline',

  // ── o gate de permissão ──────────────────────────────────────
  'gate.download.titulo': 'downloads exigem login',
  'gate.download.corpo':
    'entre na sua conta para salvar "{faixa}" no aparelho e ouvir sem conexão.',
  'gate.pro.titulo': '"{faixa}" é uma faixa [pro]',
  'gate.pro.corpo':
    'entre gratuitamente para liberar o catálogo completo — ou continue ouvindo as faixas grátis.',

  // ── atalhos: grupos, ações e legenda ─────────────────────────
  'atalho.grupo.tocar': 'tocar',
  'atalho.grupo.ir': 'ir',
  'atalho.grupo.selecionar': 'selecionar',
  'atalho.grupo.janela': 'janela',
  'atalho.grupo.dev': 'dev',

  'atalho.playPause': 'tocar ou pausar',
  'atalho.proxAnterior': 'próxima e anterior',
  'atalho.seek': 'avançar e voltar 10s',
  'atalho.curtir': 'curtir',
  'atalho.baixar': 'baixar ou remover do aparelho',
  'atalho.compartilhar': 'compartilhar o link',
  'atalho.aleatorio': 'aleatório',
  'atalho.repetir': 'repetir',
  'atalho.cursor': 'descer e subir na lista',
  'atalho.tocarLinha': 'tocar a linha marcada',
  'atalho.irPorNumero': 'ir para a faixa pelo número da calha',
  'atalho.buscar': 'buscar',
  'atalho.irHome': '~/em-alta',
  'atalho.irBuscar': '~/buscar',
  'atalho.irBiblioteca': '~/biblioteca',
  'atalho.marcar': 'marcar faixas (e sair da marcação)',
  'atalho.segurar': 'o mesmo, no toque: segure a faixa',
  'atalho.marcarLinha': 'marcar ou desmarcar a linha',
  'atalho.porNaPlaylist': 'pôr as marcadas numa playlist',
  'atalho.moverNaPlaylist': 'mover a faixa na playlist aberta',
  'atalho.detalhesDaFaixa': 'detalhes da faixa que está tocando',
  'atalho.temas': 'temas',
  'atalho.conta': 'conta e aparelho',
  'atalho.sobre': 'sobre o ondas',
  'atalho.estaJanela': 'esta janela',
  'atalho.fecharJanela': 'fechar a janela de cima',
  'atalho.simularOffline': 'simular queda de rede',
  'atalho.idiomas': 'idioma',

  'tecla.segurar': 'segurar',
  'tecla.numero': 'nº',
  'tecla.ou': 'ou',
  'legenda.play': 'play',
  'legenda.faixa': 'faixa',
  'legenda.seek': '±10s',
  'legenda.buscar': 'buscar',
  'legenda.ir': 'ir',
  'legenda.numero': 'nº',
  'legenda.atalhos': 'atalhos',

  // ── janelas e botões comuns ──────────────────────────────────
  'ui.fechar': 'fechar',
  'ui.fecharEsc': '[esc] fechar',
  'ui.entrar': '[entrar]',
  'ui.sair': '[sair]',
  'ui.sim': '[sim]',
  'ui.nao': '[não]',
  'ui.aviso': 'aviso:',
  'ui.erro': 'error:',

  // ── conta (`ondas whoami`) ───────────────────────────────────
  'conta.conta': 'conta',
  'conta.plano': 'plano',
  'conta.catalogo': 'catálogo',
  'conta.catalogoPublico': 'incluir o catálogo público (audius) na lista',
  'conta.aparelho': '# aparelho — vale só neste navegador',
  'conta.buffer': 'buffer',
  'conta.bufferDesc': 'pré-carregar a próxima faixa no aparelho',
  'conta.offline': 'offline',
  'conta.espaco': 'espaço',
  'conta.limparDownloads': '[limpar downloads]',
  'conta.apagarQuantas': 'apagar {n}?',
  'conta.sairNaoApaga': 'sair não apaga os downloads deste aparelho.',

  // ── rodapé e barra inferior ──────────────────────────────────
  'barra.abrirPlayer': 'Abrir player',
  'barra.faixaAnterior': 'Faixa anterior',
  'barra.proximaFaixa': 'Próxima faixa',
  'barra.conta': 'Conta e aparelho',
  'barra.contaComTecla': 'Conta e aparelho (5)',
  'barra.simularOffline': 'Simular queda de rede (o)',
  'barra.idioma': 'Idioma (8)',
  'barra.trocarIdioma': 'Trocar idioma',
  'barra.tema': 'Tema (t ou 4)',
  'barra.trocarTema': 'Trocar tema',
  'barra.sobre': 'ondas — sobre',
  'barra.irPorNumero': 'Ir para a faixa pelo número',
  'barra.numeroPlaceholder': 'nº da faixa',

  // ── player cheio ─────────────────────────────────────────────
  'acao.tocar': 'Tocar',
  'acao.pausar': 'Pausar',
  'acao.curtir': 'Curtir',
  'acao.descurtir': 'Descurtir',
  'acao.curtirExigeConta': 'Curtir — exige entrar na conta',
  'acao.baixar': 'Baixar para offline',
  'acao.removerDoAparelho': 'Remover do aparelho',

  'player.titulo': 'titulo',
  'player.fonte': 'fonte',
  'player.posicao': 'Posição da faixa',
  'player.compartilhar': 'Compartilhar',
  'player.agoraTocando': 'agora-tocando',

  // ── gate de permissão ────────────────────────────────────────
  'gate.titulo': 'permissão negada',
  'gate.entrar': 'entrar',
  'gate.entrarEnter': '[enter] entrar',
  'gate.agoraNao': 'agora não',
  'gate.agoraNaoEsc': '[esc] agora não',

  // ── visitante ────────────────────────────────────────────────
  'visitante.aviso': 'sessão de visitante — faixas [pro] e downloads exigem login.',

  // ── playlists na tela ────────────────────────────────────────
  'playlist.novoNome': 'novo nome',
  'playlist.apagar': 'apagar?',
  'playlist.nome': 'nome da playlist',
  'playlist.nova': '[nova playlist…]',
  'playlist.renomear': '[renomear]',
  'playlist.apagarBotao': '[apagar]',
  'playlist.jaAqui': { one: '{n} já está aqui', other: '{n} já estão aqui' },
  'playlist.faixas': { one: '{n} faixa', other: '{n} faixas' },
  'playlist.marcadas': { one: '{n} marcada', other: '{n} marcadas' },
  'playlist.adicionar': '[+ playlist]',
  'playlist.remover': '[− playlist]',
  'playlist.limpar': '[limpar]',
  'playlist.subir': 'Subir na playlist',
  'playlist.descer': 'Descer na playlist',
  'playlist.rodapeSeletor': 'j/k navegar · enter escolher · esc fechar',

  // ── busca ────────────────────────────────────────────────────
  'busca.placeholder': 'faixa, artista ou #gênero',
  'busca.aria': 'Buscar faixa, artista ou gênero',

  // ── abertura ─────────────────────────────────────────────────
  'splash.pular': 'pular abertura',
  'splash.tagline': 'lado A · streaming independente',
  'splash.carregando': 'rebobinando · carregando metadados',
  'splash.pronto': 'pronto ▶',

  // ── seletor de tema ──────────────────────────────────────────
  'idioma.rodape': 'j/k navegar · enter trocar · esc fechar',
  'tema.rodape': 'j/k navegar · enter aplicar · esc fechar · passe o mouse para pré-visualizar',
  'tema.wallCapa': 'capa-atual',
  'tema.wallImagem': 'imagem',
  'tema.wallNenhum': 'nenhum',
  'tema.enviarImagem': '[enviar imagem…]',

  // ── linha da faixa ───────────────────────────────────────────
  'faixa.meu': '[meu]',
  'faixa.de': '[de {dono}]',
  'faixa.dispensar': 'dispensar {faixa}',

  // ── envio de arquivo ─────────────────────────────────────────
  'upload.enviar': 'enviar',
  'upload.preparando': 'preparando…',
  'upload.enviando': 'enviando {nome}',
  'upload.processando': 'processando…',
  'upload.pronto': 'pronto',
  'upload.sessaoExpirou': 'sua sessão expirou — entre de novo',
  'upload.adicionarArquivo': '[+ arquivo]',

  // ── login ────────────────────────────────────────────────────
  'login.janela': 'ondas — login',
  'login.ladoA': 'lado A',
  'login.intro': 'ondas v{versao} — streaming de música independente',
  'login.introLinha2': 'digite suas credenciais ou continue como visitante.',
  'login.entrarCompleto': 'entrar — catálogo completo + offline',
  'login.visitante': 'continuar como visitante — só faixas grátis',

  // ── rota da faixa ────────────────────────────────────────────
  'faixa.voltarHome': '[{home}]',
  'login.autenticado': 'autenticado como {nome} — catálogo completo liberado',
  'share.linkCopiadoSimples': 'link copiado',
  'faixa.linkInvalido': 'link de faixa inválido.',
  'faixa.naoEncontrada': 'faixa não encontrada — o link pode estar velho ou a faixa saiu do ar.',
  'faixa.privadaAviso': 'faixa privada — ela é do acervo de alguém e só abre com a conta dona.',
  'semRede.playlistNaoCriada': 'sem rede — a playlist não foi criada',
  'semRede.nomeNaoMudou': 'sem rede — o nome não mudou',
  'semRede.playlistNaoApagada': 'sem rede — a playlist não foi apagada',
  'semRede.faixasNaoEntraram': 'sem rede — as faixas não entraram',
  'semRede.faixasNaoSairam': 'sem rede — as faixas não saíram',
  'semRede.ordemNaoSalva': 'sem rede — a ordem não foi salva',
  'tecla.espaco': 'espaço',
  'erro.semOffline': 'este navegador não guarda faixas offline',
  'erro.streamIndisponivel': 'stream indisponível',
  'erro.canvasIndisponivel': 'canvas 2d indisponível',
  'erro.lerImagem': 'não foi possível ler a imagem',
  'share.linkCopiado': 'link copiado — só você abre esta faixa',

  // ── sobre ────────────────────────────────────────────────────
  'sobre.versao': 'versão',
  'sobre.feitoCom': 'feito com',
  'sobre.notas': '[notas da versão]',
  'sobre.texto1':
    'ondas é um player de música com estética de terminal — a fita roda, a lista é a tela, e tudo se faz pelo teclado.',
  // `{autor}` fica no catálogo, e não no componente, porque é no meio da frase
  // que o nome cai — e a posição dele muda com o idioma. Quem o troca pelo link
  // do github é `tAoRedor` (ver `i18n/index.ts`).
  'sobre.texto2': 'um dos side projects de {autor}, feitos para estudar IA.',

  // ── notas de versão (`ondas --changelog`) ────────────────────
  'changelog.atual': '[em uso]',

  // ── avisos passageiros (toasts) ──────────────────────────────
  'toast.semRede': 'sem rede — o player retoma quando ela voltar',
  'toast.playerDesistiu': 'não deu para tocar — toque em play para tentar de novo',
  'toast.nadaParaTocar': 'nada para tocar à frente',
  'toast.retomando': 'rede de volta — retomando',
  'toast.continuando': 'continuando de onde parou',
  'toast.naoComecou': 'o player não começou — toque em play',
  'toast.versaoNova': 'versão nova — recarregue quando quiser',
  'toast.faixaNaoExiste': 'faixa {numero} não existe',
  'toast.curtirExigeConta': 'curtir exige entrar na conta',
  'toast.playlistsExigemConta': 'playlists exigem entrar na conta',
  'toast.faixasParaPlaylist': {
    one: '{n} faixa → {nome}',
    other: '{n} faixas → {nome}',
  },
  'toast.playlistCriadaAbra': 'playlist criada — abra em --{recorte}',
  'toast.playlistCriada': 'playlist "{nome}" criada',
  'toast.faixasTiradas': {
    one: 'faixa tirada da playlist',
    other: 'faixas tiradas da playlist',
  },
  'toast.playlistRenomeada': 'playlist → {nome}',
  'toast.playlistApagada': 'playlist "{nome}" apagada',
  'toast.removidaDoAparelho': 'removida do aparelho',
  'toast.conecteParaBaixar': 'conecte-se para baixar',
  'toast.bufferSalvo': 'buffer: próxima faixa salva',
  'toast.salvaNoAparelho': 'salva no aparelho',
  'toast.semEspaco': 'sem espaço no aparelho — limpe downloads em {janelaConta}',
  'toast.falhaDownload': 'falha no download',
  'toast.tema': 'tema → {tema}',
  'toast.falhaCatalogo': 'não foi possível mudar o catálogo',
  'toast.catalogoLigado': 'catálogo público → ligado',
  'toast.catalogoDesligado': 'catálogo público → desligado',
  'toast.downloadsApagados': 'downloads apagados — {tamanho} liberados',
  'toast.redeConectada': 'rede conectada',
  'toast.redeDesconectada': 'rede desconectada',
  'toast.streamIndisponivel': 'stream indisponível — pulando faixa',
  'toast.nenhumaPlaylistAinda':
    'nenhuma playlist ainda — use [{botaoPlaylist}] para criar a primeira',
  'toast.sessaoExpirada': 'sessão expirada — entre de novo',
  'toast.falhaLerImagem': 'não foi possível ler a imagem',

  // ── erros vindos do servidor, por código ─────────────────────
  // A API manda o código; a frase é escolhida aqui. Ver `erros.go`.
  'erro.acervo_nao_configurado': 'acervo não configurado',
  'erro.arquivo_ausente_no_bucket': 'o arquivo não chegou ao bucket — refaça o envio',
  'erro.arquivo_grande_demais': 'arquivo grande demais: o limite é {limite}',
  'erro.arquivo_vazio': 'o arquivo chegou vazio',
  'erro.banco_indisponivel': 'banco indisponível',
  'erro.cadastro_fechado': 'cadastro fechado',
  'erro.credenciais_invalidas': 'credenciais inválidas',
  'erro.destinatarios_demais': 'destinatários demais num pedido',
  'erro.destino_indisponivel': 'destino não disponível',
  'erro.destino_repetido': 'o mesmo destino em `com` e `sem`',
  'erro.email_em_uso': 'e-mail já cadastrado',
  'erro.email_invalido': 'e-mail inválido',
  'erro.faixa_nao_encontrada': 'faixa não encontrada',
  'erro.faixa_sem_arquivo': 'faixa sem este arquivo',
  'erro.falha_buscar_faixa': 'erro ao buscar a faixa',
  'erro.falha_compartilhar': 'não foi possível compartilhar',
  'erro.falha_confirmar_envio': 'não foi possível confirmar o envio',
  'erro.falha_consultar': 'erro ao consultar',
  'erro.falha_criar_conta': 'não foi possível criar a conta',
  'erro.falha_enfileirar': 'não foi possível enfileirar',
  'erro.falha_entrar': 'não foi possível entrar',
  'erro.falha_ler_acervo': 'não foi possível ler o acervo',
  'erro.falha_ler_curtidas': 'não foi possível ler as curtidas',
  'erro.falha_ler_playlists': 'não foi possível ler as playlists',
  'erro.falha_liberar_arquivo': 'erro ao liberar o arquivo',
  'erro.falha_preparar_envio': 'não foi possível preparar o envio',
  'erro.falha_remover': 'não foi possível remover',
  'erro.falha_resolver_destino': 'não foi possível resolver o destino',
  'erro.falha_salvar_curtidas': 'não foi possível salvar as curtidas',
  'erro.falha_salvar_playlist': 'não foi possível salvar a playlist',
  'erro.falha_salvar_preferencia': 'não foi possível salvar a preferência',
  'erro.id_repetido': 'o mesmo id em `add` e `remove`',
  'erro.ingestao_nao_encontrada': 'ingestão não encontrada',
  'erro.ingest_demorou': 'a origem demorou demais',
  'erro.ingest_destino_vetado': 'endereço de destino não é público — só URLs da internet',
  'erro.ingest_falhou': 'não foi possível ingerir esta mídia',
  'erro.ingest_objeto_ausente': 'o arquivo enviado não está mais no bucket — refaça o envio',
  'erro.ingest_sem_audio': 'o arquivo não tem faixa de áudio',
  'erro.ingest_url_invalida': 'url inválida',
  'erro.muitas_tentativas': 'muitas tentativas — espere alguns minutos',
  'erro.nome_invalido': 'nome inválido',
  'erro.playlist_limite_contas': 'limite de {limite} playlists por conta',
  'erro.playlist_limite_faixas': 'limite de {limite} faixas por playlist',
  'erro.playlist_nao_encontrada': 'playlist não encontrada',
  'erro.playlist_nome_em_uso': 'já existe uma playlist com esse nome',
  'erro.requisicao_invalida': 'requisição inválida',
  'erro.resposta_inesperada': 'resposta inesperada do servidor',
  'erro.senha_curta': 'senha precisa de {minimo}+ caracteres',
  'erro.servidor_indisponivel': 'servidor indisponível — tente de novo',
  'erro.sessao_expirada': 'sessão expirada',
  'erro.tamanho_ausente': 'informe o tamanho do arquivo',
  'erro.token_invalido': 'token inválido',
  'erro.url_ausente': 'informe a url da mídia',
  'erro.url_esquema_invalido': 'a url precisa ser http(s)',
  'erro.url_longa_demais': 'url longa demais',
  'erro.visibilidade_invalida': 'visibilidade inválida',
} as const satisfies Record<string, Frase>;

/** A chave de toda frase do app. `en` e `es` são conferidos contra ela. */
export type Chave = keyof typeof PT_BR;

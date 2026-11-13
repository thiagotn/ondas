package httpapi

// O vocabulário de erro da API, num lugar só.
//
// A API mandava só a frase, em pt-BR, porque a PWA a exibia crua — está escrito
// assim no comentário que havia em `escreverErro`. Com a PWA em três idiomas
// isso deixou de servir: ou o servidor passava a conhecer o idioma de quem
// pergunta, e as traduções viveriam em dois repositórios, ou ele volta a dizer
// só O QUE aconteceu e deixa a escolha da frase para quem desenha a tela. É a
// segunda.
//
// A frase em pt-BR CONTINUA indo no campo `error`, e de propósito: ela é o que
// um cliente antigo (ou um curl) lê, e é o fallback da PWA para um código que
// ela ainda não conheça. O que muda é que agora existe um `code` ao lado.
//
// A tabela é indexada pela mensagem em vez de o código entrar em cada um dos
// 54 `escreverErro`: assim o vocabulário inteiro cabe numa tela, e acrescentar
// um erro sem código degrada para o comportamento de antes em vez de quebrar.
// `TestTodoErroTemCodigo` cobre o esquecimento.
const (
	CodAcervoNaoConfigurado  = "acervo_nao_configurado"
	CodArquivoAusenteBucket  = "arquivo_ausente_no_bucket"
	CodArquivoGrandeDemais   = "arquivo_grande_demais"
	CodArquivoVazio          = "arquivo_vazio"
	CodBancoIndisponivel     = "banco_indisponivel"
	CodCadastroFechado       = "cadastro_fechado"
	CodCadastroNegado        = "cadastro_negado"
	CodContaEmAnalise        = "conta_em_analise"
	CodContaNaoEncontrada    = "conta_nao_encontrada"
	CodCredenciaisInvalidas  = "credenciais_invalidas"
	CodDestinatariosDemais   = "destinatarios_demais"
	CodDestinoIndisponivel   = "destino_indisponivel"
	CodDestinoRepetido       = "destino_repetido"
	CodEmailEmUso            = "email_em_uso"
	CodEmailInvalido         = "email_invalido"
	CodEnvioNaoPermitido     = "envio_nao_permitido"
	CodFaixaNaoEncontrada    = "faixa_nao_encontrada"
	CodFaixaSemArquivo       = "faixa_sem_arquivo"
	CodFalhaApagarConta      = "falha_apagar_conta"
	CodFalhaBuscarFaixa      = "falha_buscar_faixa"
	CodFalhaCompartilhar     = "falha_compartilhar"
	CodFalhaConfirmarEnvio   = "falha_confirmar_envio"
	CodFalhaConsultar        = "falha_consultar"
	CodFalhaCriarConta       = "falha_criar_conta"
	CodFalhaEnfileirar       = "falha_enfileirar"
	CodFalhaLerAcervo        = "falha_ler_acervo"
	CodFalhaLerCurtidas      = "falha_ler_curtidas"
	CodFalhaLerHistorico     = "falha_ler_historico"
	CodFalhaLerMarcador      = "falha_ler_marcador"
	CodFalhaLerPlaylists     = "falha_ler_playlists"
	CodFalhaLiberarArquivo   = "falha_liberar_arquivo"
	CodFalhaPrepararEnvio    = "falha_preparar_envio"
	CodFalhaLerContas        = "falha_ler_contas"
	CodFalhaRemover          = "falha_remover"
	CodFalhaSalvarConta      = "falha_salvar_conta"
	CodFalhaResolverDestino  = "falha_resolver_destino"
	CodFalhaSalvarCurtidas   = "falha_salvar_curtidas"
	CodFalhaSalvarHistorico  = "falha_salvar_historico"
	CodFalhaSalvarMarcador   = "falha_salvar_marcador"
	CodFalhaSalvarPlaylist   = "falha_salvar_playlist"
	CodFalhaSalvarPreferenc  = "falha_salvar_preferencia"
	CodIDRepetido            = "id_repetido"
	CodIngestaoNaoEncontrada = "ingestao_nao_encontrada"
	CodMuitasTentativas      = "muitas_tentativas"
	CodNomeInvalido          = "nome_invalido"
	CodPlaylistLimiteContas  = "playlist_limite_contas"
	CodPlaylistLimiteFaixas  = "playlist_limite_faixas"
	CodPlaylistNaoEncontrada = "playlist_nao_encontrada"
	CodPlaylistNomeEmUso     = "playlist_nome_em_uso"
	CodRequisicaoInvalida    = "requisicao_invalida"
	CodSenhaAtualIncorreta   = "senha_atual_incorreta"
	CodSenhaCurta            = "senha_curta"
	CodSessaoExpirada        = "sessao_expirada"
	CodTamanhoAusente        = "tamanho_ausente"
	CodTokenInvalido         = "token_invalido"
	CodURLAusente            = "url_ausente"
	CodURLEsquemaInvalido    = "url_esquema_invalido"
	CodURLLongaDemais        = "url_longa_demais"
	CodVisibilidadeInvalida  = "visibilidade_invalida"

	// Erros de ingestão. O worker grava a frase na linha do job; o código sai
	// dela na hora de servir o status (ver `jobJSON`).
	CodIngestDestinoVetado = "ingest_destino_vetado"
	CodIngestURLInvalida   = "ingest_url_invalida"
	CodIngestObjetoAusente = "ingest_objeto_ausente"
	CodIngestSemAudio      = "ingest_sem_audio"
	CodIngestDemorou       = "ingest_demorou"
	CodIngestFalhou        = "ingest_falhou"
)

// codigoPorMensagem mapeia cada frase que a API devolve ao seu código estável.
//
// As entradas com `%d` resolvido (senha, tetos de playlist) entram pelo texto
// final porque é ele que chega aqui — os parâmetros viajam à parte, em
// `params`, para a PWA poder formatar o número no locale de quem lê.
var codigoPorMensagem = map[string]string{
	"acervo não configurado":                          CodAcervoNaoConfigurado,
	"a url precisa ser http(s)":                       CodURLEsquemaInvalido,
	"banco indisponível":                              CodBancoIndisponivel,
	"cadastro fechado":                                CodCadastroFechado,
	"cadastro negado":                                 CodCadastroNegado,
	"conta em análise":                                CodContaEmAnalise,
	"conta não encontrada":                            CodContaNaoEncontrada,
	"envio de arquivos não liberado para esta conta":  CodEnvioNaoPermitido,
	"não foi possível apagar a conta":                 CodFalhaApagarConta,
	"não foi possível ler as contas":                  CodFalhaLerContas,
	"não foi possível salvar a conta":                 CodFalhaSalvarConta,
	"senha atual incorreta":                           CodSenhaAtualIncorreta,
	"credenciais inválidas":                           CodCredenciaisInvalidas,
	"destinatários demais num pedido":                 CodDestinatariosDemais,
	"destino não disponível":                          CodDestinoIndisponivel,
	"e-mail inválido":                                 CodEmailInvalido,
	"e-mail já cadastrado":                            CodEmailEmUso,
	"erro ao buscar a faixa":                          CodFalhaBuscarFaixa,
	"erro ao consultar":                               CodFalhaConsultar,
	"erro ao liberar o arquivo":                       CodFalhaLiberarArquivo,
	"faixa não encontrada":                            CodFaixaNaoEncontrada,
	"faixa sem este arquivo":                          CodFaixaSemArquivo,
	"informe a url da mídia":                          CodURLAusente,
	"informe o tamanho do arquivo":                    CodTamanhoAusente,
	"ingestão não encontrada":                         CodIngestaoNaoEncontrada,
	"já existe uma playlist com esse nome":            CodPlaylistNomeEmUso,
	"muitas tentativas — espere alguns minutos":       CodMuitasTentativas,
	"não foi possível compartilhar":                   CodFalhaCompartilhar,
	"não foi possível confirmar o envio":              CodFalhaConfirmarEnvio,
	"não foi possível criar a conta":                  CodFalhaCriarConta,
	"não foi possível enfileirar":                     CodFalhaEnfileirar,
	"não foi possível ler as curtidas":                CodFalhaLerCurtidas,
	"não foi possível ler as playlists":               CodFalhaLerPlaylists,
	"não foi possível ler o acervo":                   CodFalhaLerAcervo,
	"não foi possível ler o histórico":                CodFalhaLerHistorico,
	"não foi possível ler o marcador":                 CodFalhaLerMarcador,
	"não foi possível preparar o envio":               CodFalhaPrepararEnvio,
	"não foi possível remover":                        CodFalhaRemover,
	"não foi possível resolver o destino":             CodFalhaResolverDestino,
	"não foi possível salvar a playlist":              CodFalhaSalvarPlaylist,
	"não foi possível salvar a preferência":           CodFalhaSalvarPreferenc,
	"não foi possível salvar as curtidas":             CodFalhaSalvarCurtidas,
	"não foi possível salvar o histórico":             CodFalhaSalvarHistorico,
	"não foi possível salvar o marcador":              CodFalhaSalvarMarcador,
	"nome inválido":                                   CodNomeInvalido,
	"o arquivo chegou vazio":                          CodArquivoVazio,
	"o arquivo não chegou ao bucket — refaça o envio": CodArquivoAusenteBucket,
	"o mesmo destino em `com` e `sem`":                CodDestinoRepetido,
	"o mesmo id em `add` e `remove`":                  CodIDRepetido,
	"playlist não encontrada":                         CodPlaylistNaoEncontrada,
	"requisição inválida":                             CodRequisicaoInvalida,
	"sessão expirada":                                 CodSessaoExpirada,
	"token inválido":                                  CodTokenInvalido,
	"url longa demais":                                CodURLLongaDemais,
	"visibilidade inválida":                           CodVisibilidadeInvalida,

	"endereço de destino não é público — só URLs da internet": CodIngestDestinoVetado,
	"url inválida": CodIngestURLInvalida,
	"o arquivo enviado não está mais no bucket — refaça o envio": CodIngestObjetoAusente,
	"o arquivo não tem faixa de áudio":                           CodIngestSemAudio,
	"a origem demorou demais":                                    CodIngestDemorou,
	"não foi possível ingerir esta mídia":                        CodIngestFalhou,
}

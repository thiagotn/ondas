package auth

import (
	"sync"
	"time"
)

// Limitador de tentativas de login, em memória e por cliente.
//
// Mora aqui e não no Traefik porque o Traefik do cluster não enxerga o IP real
// (o hostPort mascara a origem), então o rate-limit dele vale para o host
// inteiro. Como o único caminho de entrada é o túnel da Cloudflare, o
// `CF-Connecting-IP` é confiável o bastante para esta contagem.
//
// Limitação assumida: o contador é em memória, então um restart do pod zera os
// bloqueios. Para um punhado de contas é aceitável; se virar problema, o lugar
// certo é o Postgres.
type Limiter struct {
	mu       sync.Mutex
	tentou   map[string][]time.Time
	max      int
	janela   time.Duration
	agora    func() time.Time
	ultimaGC time.Time
}

func NewLimiter(max int, janela time.Duration) *Limiter {
	return &Limiter{tentou: map[string][]time.Time{}, max: max, janela: janela, agora: time.Now}
}

// Permitido registra a tentativa e diz se ela deve prosseguir.
func (l *Limiter) Permitido(chave string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	agora := l.agora()
	l.coletar(agora)

	recentes := l.recentes(chave, agora)
	if len(recentes) >= l.max {
		l.tentou[chave] = recentes
		return false
	}
	l.tentou[chave] = append(recentes, agora)
	return true
}

// Esquecer limpa o histórico depois de um login bem-sucedido.
func (l *Limiter) Esquecer(chave string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.tentou, chave)
}

func (l *Limiter) recentes(chave string, agora time.Time) []time.Time {
	corte := agora.Add(-l.janela)
	manter := l.tentou[chave][:0]
	for _, t := range l.tentou[chave] {
		if t.After(corte) {
			manter = append(manter, t)
		}
	}
	return manter
}

// Sem isto o mapa cresce para sempre com IPs que nunca mais voltam.
func (l *Limiter) coletar(agora time.Time) {
	if agora.Sub(l.ultimaGC) < l.janela {
		return
	}
	l.ultimaGC = agora
	for chave := range l.tentou {
		if len(l.recentes(chave, agora)) == 0 {
			delete(l.tentou, chave)
		}
	}
}

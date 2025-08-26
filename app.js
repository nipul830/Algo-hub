/* ======= Global State (persisted) ======= */
const LS_KEY = 'jk_algo_demo';
const defaultState = {
  capital: 1000,
  leverage: 100,
  sizeUSDT: 100,
  pair: 'BTCUSDT',
  tf: '5m',
  running: false,
  strategy: 'ema_cross',
  show: { EMA:true, BB:true, RSI:true, PIV:true, MACD:false },
  position: null,              // {side:'LONG/SHORT', qty, entry, time, lev, margin}
  closed: []                   // [{time, pair, side, qty, entry, exit, pnl}]
};
let S = load();
function load(){ try{ return {...defaultState, ...(JSON.parse(localStorage.getItem(LS_KEY)||'{}'))}; }catch{ return {...defaultState}; } }
function save(){ localStorage.setItem(LS_KEY, JSON.stringify(S)); }

/* ======= Utils ======= */
const fmt$ = n => (n==null?'--':('$'+Number(n).toFixed(2)));
const fmt  = n => (n==null?'--':Number(n).toFixed(2));

/* ======= Data (Binance klines) ======= */
async function fetchKlines(sym, tf='5m', limit=500){
  const map = { '1m':'1m', '5m':'5m', '15m':'15m', '1h':'1h' };
  const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${map[tf]||'5m'}&limit=${limit}`;
  const r = await fetch(url); const a = await r.json();
  return a.map(k=>({
    time: Math.floor(k[0]/1000), open: +k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
  }));
}

/* ======= Indicators ======= */
function ema(arr, len, src='close'){
  const out=[]; const k=2/(len+1);
  let prev;
  for(let i=0;i<arr.length;i++){
    const v = arr[i][src] ?? arr[i];
    if(i===0) prev=v;
    const e = v*k + prev*(1-k);
    out.push(e); prev=e;
  }
  return out;
}
function sma(arr,len, src='close'){
  const out=[]; let sum=0;
  for(let i=0;i<arr.length;i++){
    sum += arr[i][src] ?? arr[i];
    if(i>=len) sum -= arr[i-len][src] ?? arr[i-len];
    out.push(i>=len-1 ? sum/len : NaN);
  }
  return out;
}
function stddev(arr,len,src='close'){
  const out=[]; for(let i=0;i<arr.length;i++){
    if(i<len-1){ out.push(NaN); continue; }
    const slice = arr.slice(i-len+1, i+1).map(o=>o[src]);
    const m = slice.reduce((a,b)=>a+b,0)/len;
    const v = slice.reduce((a,b)=>a+(b-m)*(b-m),0)/len;
    out.push(Math.sqrt(v));
  } return out;
}
function rsi(arr, len=14){
  const out=[]; let up=0, dn=0;
  for(let i=0;i<arr.length;i++){
    if(i===0){ out.push(NaN); continue; }
    const ch = arr[i].close - arr[i-1].close;
    const gain = Math.max(ch,0), loss = Math.max(-ch,0);
    if(i<=len){ up += gain; dn += loss; out.push(NaN); }
    else{
      up = (up*(len-1)+gain)/len;
      dn = (dn*(len-1)+loss)/len;
      const rs = dn===0?100:up/dn;
      out.push(100 - 100/(1+rs));
    }
  } return out;
}
function macd(arr, fast=12, slow=26, signal=9){
  const c = arr.map(o=>o.close);
  const efast = ema(arr, fast, 'close');
  const eslow = ema(arr, slow, 'close');
  const macdLine = efast.map((v,i)=> v - eslow[i]);
  const signalLine = ema(macdLine.map(x=>({close:x})), signal, 'close');
  const hist = macdLine.map((v,i)=> v - signalLine[i]);
  return { macdLine, signalLine, hist };
}
function pivotsClassic(arr){ // prev day H/L/C
  if(arr.length<2) return null;
  const lastDay = new Date(arr[arr.length-1].time*1000).getUTCDate();
  const prev = arr.filter(o=> new Date(o.time*1000).getUTCDate()!==lastDay);
  if(prev.length===0) return null;
  const day = prev.slice(-1440); // approx 1 day
  const H = Math.max(...day.map(o=>o.high));
  const L = Math.min(...day.map(o=>o.low));
  const C = day[day.length-1].close;
  const P = (H+L+C)/3;
  const R1 = 2*P - L, S1 = 2*P - H;
  return {P,R1,S1};
}

/* ======= Charts (Home + Market) ======= */
let priceChart, rsiChart, macdChart, candleSeries, ema12Series, ema26Series, bbUpper, bbBasis, bbLower, markers=[];
let rsiLine, macdMain, macdSig, macdHist;

function buildCharts(priceEl, rsiEl, macdEl){
  // destroy previous by clearing containers
  priceEl.innerHTML=''; rsiEl.innerHTML=''; macdEl.innerHTML='';
  // price
  priceChart = LightweightCharts.createChart(priceEl,{layout:{textColor:'#e6edf3',background:{type:'solid',color:'#0f1724'}},
    crosshair:{mode:1}, rightPriceScale:{borderVisible:false}, timeScale:{borderVisible:false}});
  candleSeries = priceChart.addCandlestickSeries();
  ema12Series = priceChart.addLineSeries({color:'#1dd1a1', lineWidth:2});
  ema26Series = priceChart.addLineSeries({color:'#ee5253', lineWidth:2});
  bbUpper = priceChart.addLineSeries({color:'#8ab4f8', lineWidth:1});
  bbBasis = priceChart.addLineSeries({color:'#cfd8e3', lineWidth:1});
  bbLower = priceChart.addLineSeries({color:'#8ab4f8', lineWidth:1});
  // RSI
  rsiChart = LightweightCharts.createChart(rsiEl,{height:140, layout:{textColor:'#cfe1ff',background:{type:'solid',color:'#0f1724'}},
    rightPriceScale:{borderVisible:false}, timeScale:{visible:false}});
  rsiLine = rsiChart.addLineSeries({color:'#f1c40f', lineWidth:2});
  // MACD
  macdChart = LightweightCharts.createChart(macdEl,{height:140, layout:{textColor:'#cfe1ff',background:{type:'solid',color:'#0f1724'}},
    rightPriceScale:{borderVisible:false}, timeScale:{visible:false}});
  macdMain = macdChart.addLineSeries({color:'#42a5f5', lineWidth:2});
  macdSig  = macdChart.addLineSeries({color:'#f06292', lineWidth:2});
  macdHist = macdChart.addHistogramSeries({color:'#8bc34a'});
}

async function loadAndRender(sym, tf){
  const data = await fetchKlines(sym, tf, 500);
  // set data
  candleSeries.setData(data);
  // indicators
  const e12 = ema(data,12), e26=ema(data,26);
  ema12Series.setData(data.map((d,i)=>({time:d.time,value:e12[i]})));
  ema26Series.setData(data.map((d,i)=>({time:d.time,value:e26[i]})));
  const bbLen=20, bbDev=2;
  const basis = sma(data, bbLen);
  const dev = stddev(data, bbLen);
  bbUpper.setData(data.map((d,i)=>({time:d.time,value: (basis[i] && dev[i])? (basis[i]+bbDev*dev[i]):NaN})));
  bbBasis.setData(data.map((d,i)=>({time:d.time,value: basis[i]})));
  bbLower.setData(data.map((d,i)=>({time:d.time,value: (basis[i] && dev[i])? (basis[i]-bbDev*dev[i]):NaN})));
  const r = rsi(data,14);
  rsiLine.setData(data.map((d,i)=>({time:d.time,value:r[i]})));
  const m = macd(data,12,26,9);
  macdMain.setData(data.map((d,i)=>({time:d.time,value:m.macdLine[i]})));
  macdSig.setData (data.map((d,i)=>({time:d.time,value:m.signalLine[i]})));
  macdHist.setData(data.map((d,i)=>({time:d.time,value:m.hist[i], color:(m.hist[i]>=0?'#66bb6a':'#ef5350')})));

  // pivots
  const piv = pivotsClassic(data);
  if(piv){
    // draw as horizontal lines by adding extra series temporarily
    // (simple: set priceLines)
    candleSeries.createPriceLine({price:piv.P, color:'#9aa7b2', lineStyle:0, title:'P'});
    candleSeries.createPriceLine({price:piv.R1, color:'#8bc34a', lineStyle:0, title:'R1'});
    candleSeries.createPriceLine({price:piv.S1, color:'#ef5350', lineStyle:0, title:'S1'});
  }

  applyIndicatorVisibility();
  priceChart.timeScale().fitContent();
  rsiChart.timeScale().fitContent();
  macdChart.timeScale().fitContent();

  // evaluate immediate floating pnl display
  updateFloating(data[data.length-1].close);
  return data;
}

function applyIndicatorVisibility(){
  ema12Series.applyOptions({visible: !!S.show.EMA});
  ema26Series.applyOptions({visible: !!S.show.EMA});
  const showBB = !!S.show.BB;
  bbUpper.applyOptions({visible: showBB});
  bbBasis.applyOptions({visible: showBB});
  bbLower.applyOptions({visible: showBB});
  const showRSI = !!S.show.RSI;
  rsiChart.applyOptions({height: showRSI?140:0});
  document.getElementById('rsiChart')?.classList.toggle('hide', !showRSI);
  const showMACD = !!S.show.MACD;
  macdChart.applyOptions({height: showMACD?140:0});
  document.getElementById('macdChart')?.classList.toggle('hide', !showMACD);
}

/* ======= Trading / Strategy Engine (demo) ======= */
function placeOrder(side, price){
  if(S.position) return; // one at a time
  const qty = Math.max(0.0001, S.sizeUSDT / price);
  const margin = (price*qty)/Math.max(1, Math.min(2000, S.leverage));
  S.position = { side, qty, entry: price, time: new Date().toLocaleString(), lev: S.leverage, margin };
  save();
  // marker
  markers.push({ time: Math.floor(Date.now()/1000), position: side==='LONG'?'belowBar':'aboveBar',
    color: side==='LONG'?'#1f8f6b':'#b3474f', shape: side==='LONG'?'arrowUp':'arrowDown', text:`${side} @ ${fmt(price)}` });
  candleSeries.setMarkers(markers);
}
function closePosition(price){
  if(!S.position) return;
  const p = S.position;
  const pnl = (p.side==='LONG' ? (price - p.entry) : (p.entry - price)) * p.qty;
  S.capital += pnl;                        // realize to capital
  S.closed.unshift({ time:new Date().toLocaleString(), pair:S.pair, side:p.side, qty:p.qty, entry:p.entry, exit:price, pnl });
  S.position = null; save();
  // marker
  markers.push({ time: Math.floor(Date.now()/1000), position:'aboveBar', color:'#cfd8e3', shape:'circle', text:`EXIT @ ${fmt(price)} PnL ${fmt(pnl)}` });
  candleSeries.setMarkers(markers);
  updateFloating(price);
}
function strategySignal(data){ // returns 'LONG' / 'SHORT' / null (on last CLOSED bar)
  if(data.length<30) return null;
  const i = data.length-2; // last closed bar index
  const last = data[i], prev = data[i-1];
  const e12 = ema(data,12), e26 = ema(data,26);
  const r = rsi(data,14);
  const m = macd(data,12,26,9);
  const bbLen=20, dev=2, ma = sma(data,bbLen), sd = stddev(data,bbLen);
  const upper = ma[i] + dev*sd[i], lower = ma[i] - dev*sd[i];

  switch(S.strategy){
    case 'ema_cross':
      if(e12[i] > e26[i] && e12[i-1] <= e26[i-1]) return 'LONG';
      if(e12[i] < e26[i] && e12[i-1] >= e26[i-1]) return 'SHORT';
      break;
    case 'rsi_macd':
      if(r[i] < 30 && m.hist[i] > 0 && m.hist[i-1] <= 0) return 'LONG';
      if(r[i] > 70 && m.hist[i] < 0 && m.hist[i-1] >= 0) return 'SHORT';
      break;
    case 'bb_bounce':
      if(last.close < lower) return 'LONG';
      if(last.close > upper) return 'SHORT';
      break;
    case 'pivot_break': {
      const piv = pivotsClassic(data); if(!piv) break;
      if(prev.close <= piv.R1 && last.close > piv.R1) return 'LONG';
      if(prev.close >= piv.S1 && last.close < piv.S1) return 'SHORT';
      break;
    }
    case 'macd_cross':
      if(m.macdLine[i] > m.signalLine[i] && m.macdLine[i-1] <= m.signalLine[i-1]) return 'LONG';
      if(m.macdLine[i] < m.signalLine[i] && m.macdLine[i-1] >= m.signalLine[i-1]) return 'SHORT';
      break;
  }
  return null;
}

/* ======= Floating badge ======= */
function updateFloating(mark){
  const capEl = document.getElementById('capVal');
  const pnlEl = document.getElementById('pnlVal');
  const mEl   = document.getElementById('marginVal');
  if(capEl) capEl.textContent = fmt$(S.capital);
  let u = 0, margin=0;
  if(S.position){
    u = (S.position.side==='LONG' ? (mark - S.position.entry) : (S.position.entry - mark)) * S.position.qty;
    margin = S.position.margin;
  }
  if(pnlEl) pnlEl.textContent = (u>=0?'+':'') + fmt$(u);
  if(mEl) mEl.textContent = fmt$(margin);
  // positions page stats
  const stC = document.getElementById('stCap'); if(stC) stC.textContent = fmt$(S.capital);
  const stF = document.getElementById('stFloat'); if(stF) stF.textContent = (u>=0?'+':'') + fmt$(u);
  const stM = document.getElementById('stMargin'); if(stM) stM.textContent = fmt$(margin);
}

/* ======= Page Routers ======= */
document.addEventListener('DOMContentLoaded', async () => {
  const path = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // Common: set badge initial numbers
  updateFloating(0);

  if(path.includes('index.html') || path==='' ){
    // Home page
    // bind inputs
    document.getElementById('pairSel').value = S.pair;
    document.getElementById('tfSel').value = S.tf;
    document.getElementById('levInp').value = S.leverage;
    document.getElementById('sizeUSDT').value = S.sizeUSDT;
    document.getElementById('capInp').value = S.capital;
    document.getElementById('stratSel').value = S.strategy;
    document.getElementById('indEMA').checked = !!S.show.EMA;
    document.getElementById('indBB').checked  = !!S.show.BB;
    document.getElementById('indRSI').checked = !!S.show.RSI;
    document.getElementById('indPiv').checked = !!S.show.PIV;
    document.getElementById('indMACD').checked= !!S.show.MACD;

    const priceEl = document.getElementById('priceChart');
    const rsiEl   = document.getElementById('rsiChart');
    const macdEl  = document.getElementById('macdChart');
    buildCharts(priceEl, rsiEl, macdEl);
    let data = await loadAndRender(S.pair, S.tf);

    // Start/Stop
    const stateEl = document.getElementById('algoState');
    function setRun(v){ S.running=v; save(); stateEl.textContent=v?'Running':'Stopped'; stateEl.classList.toggle('green', v); stateEl.classList.toggle('red', !v); }
    setRun(S.running);

    document.getElementById('btnStart').onclick=()=>{ S.capital = +document.getElementById('capInp').value||S.capital; setRun(true); updateFloating(data.at(-1).close); };
    document.getElementById('btnStop').onclick =()=> setRun(false);
    document.getElementById('btnReset').onclick=()=>{
      if(confirm('Reset capital, positions, history?')){
        S = {...defaultState}; save(); location.reload();
      }
    };

    // Apply to chart
    document.getElementById('btnApply').onclick=async ()=>{
      S.pair      = document.getElementById('pairSel').value;
      S.tf        = document.getElementById('tfSel').value;
      S.leverage  = Math.max(1, Math.min(2000, +document.getElementById('levInp').value||100));
      S.sizeUSDT  = Math.max(5, +document.getElementById('sizeUSDT').value||100);
      S.strategy  = document.getElementById('stratSel').value;
      S.show = {
        EMA:  document.getElementById('indEMA').checked,
        BB:   document.getElementById('indBB').checked,
        RSI:  document.getElementById('indRSI').checked,
        PIV:  document.getElementById('indPiv').checked,
        MACD: document.getElementById('indMACD').checked,
      };
      save();
      buildCharts(priceEl, rsiEl, macdEl);
      data = await loadAndRender(S.pair, S.tf);
    };

    // live updater every 7s
    setInterval(async ()=>{
      const last = (await fetchKlines(S.pair, S.tf, 2)).pop();
      if(!last) return;
      candleSeries.update(last);
      ema12Series.update({time:last.time,value:ema([last],12,'close')[0]}); // quick keep
      updateFloating(last.close);

      // strategy on closed bar
      const full = await fetchKlines(S.pair, S.tf, 120);
      if(S.running && !S.position){
        const sig = strategySignal(full);
        if(sig) placeOrder(sig, full[full.length-2].close);
      }else if(S.running && S.position){
        // simple exit: opposite signal
        const sig = strategySignal(full);
        if(sig && ((sig==='LONG' && S.position.side==='SHORT') || (sig==='SHORT' && S.position.side==='LONG'))){
          closePosition(full[full.length-2].close);
        }
      }
    }, 7000);

  } else if(path.includes('market.html')){
    // Market
    const priceEl = document.getElementById('marketChart');
    const chart = LightweightCharts.createChart(priceEl,{layout:{textColor:'#e6edf3',background:{type:'solid',color:'#0f1724'}},
      rightPriceScale:{borderVisible:false}, timeScale:{borderVisible:false}});
    const candles = chart.addCandlestickSeries();
    async function reload(){
      const p = document.getElementById('mPair').value;
      const t = document.getElementById('mTF').value;
      S.pair = p; S.tf = t; save();
      const data = await fetchKlines(p,t,500);
      candles.setData(data);
      chart.timeScale().fitContent();
      updateFloating(data.at(-1).close);
    }
    document.getElementById('mApply').onclick = reload;
    document.getElementById('mPair').value = S.pair;
    document.getElementById('mTF').value   = S.tf;
    reload();

  } else if(path.includes('positions.html')){
    // Positions
    const openT = document.querySelector('#tblOpen tbody');
    const clsT  = document.querySelector('#tblClosed tbody');
    function renderTables(mark){
      openT.innerHTML = '';
      if(S.position){
        const p = S.position;
        const markPx = mark || p.entry;
        const uPnL = (p.side==='LONG'?(markPx-p.entry):(p.entry-markPx))*p.qty;
        openT.innerHTML = `<tr>
          <td>${p.time}</td><td>${S.pair}</td><td>${p.side}</td>
          <td>${p.qty.toFixed(6)}</td><td>${p.entry.toFixed(2)}</td><td>${markPx.toFixed(2)}</td>
          <td>${p.lev}x</td><td>${fmt$(p.margin)}</td><td>${(uPnL>=0?'+':'')+fmt$(uPnL)}</td>
        </tr>`;
      } else {
        openT.innerHTML = `<tr><td colspan="9" class="muted">No open position</td></tr>`;
      }
      clsT.innerHTML = (S.closed||[]).map(r=>`<tr>
        <td>${r.time}</td><td>${r.pair}</td><td>${r.side}</td>
        <td>${r.qty.toFixed(6)}</td><td>${r.entry.toFixed(2)}</td><td>${r.exit.toFixed(2)}</td>
        <td>${(r.pnl>=0?'+':'')+fmt$(r.pnl)}</td>
      </tr>`).join('') || `<tr><td colspan="7" class="muted">No closed trades</td></tr>`;
    }
    // initial
    renderTables();

    // live mark
    setInterval(async ()=>{
      const last = (await fetchKlines(S.pair, S.tf, 2)).pop();
      if(!last) return;
      updateFloating(last.close);
      renderTables(last.close);
    }, 7000);
  }
});

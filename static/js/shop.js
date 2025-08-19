// static/js/shop.js
// Shop module: store UI, cart, orders. Exposes window.Shop
(function(){
  function updateCartBadge() {
    try {
      const navItem = document.querySelector('.nav-item[data-tab="shop"]');
      if (!navItem) return;
      const cart = readCart();
      const count = cart.reduce((s, it) => s + (it.qty||1), 0);
      const label = navItem.querySelector('.nav-label');
      if (label) label.textContent = count > 0 ? `Магазин (${count})` : 'Магазин';
      let badge = navItem.querySelector('.nav-badge');
      if (count > 0) { if (!badge) { badge = document.createElement('div'); badge.className = 'nav-badge'; navItem.appendChild(badge); } badge.textContent = String(count); }
      else if (badge) { badge.remove(); }
    } catch(_) {}
  }
  function readCart() { try { return JSON.parse(localStorage.getItem('shop:cart') || '[]'); } catch(_) { return []; } }
  function writeCart(items) { try { localStorage.setItem('shop:cart', JSON.stringify(items)); } catch(_) {} try { updateCartBadge(); } catch(_) {} }
  function addToCart(item) { const items = readCart(); const idx = items.findIndex(x => x.id === item.id); if (idx>=0) items[idx].qty=(items[idx].qty||1)+1; else items.push({ id:item.id, name:item.name, price:Number(item.price)||0, qty:1 }); writeCart(items); renderCart(); }
  function removeFromCart(id) { const items = readCart().filter(x => x.id !== id); writeCart(items); renderCart(); }
  function renderCart() {
    const host = document.querySelector('#shop-pane-cart'); if (!host) return;
    const items = readCart(); host.innerHTML = '';
    if (!items.length) { host.innerHTML = '<div style="padding:12px; color: var(--gray);">Корзина пуста.</div>'; return; }
    const list = document.createElement('div'); list.className = 'cart-list';
    let total = 0;
    items.forEach(it => {
      total += (Number(it.price)||0) * (Number(it.qty)||1);
      const row = document.createElement('div'); row.className = 'cart-row';
      const name = document.createElement('div'); name.className='cart-name'; name.textContent = `${it.name} × ${it.qty}`;
      const price = document.createElement('div'); price.className='cart-price'; price.textContent = ((Number(it.price)||0) * (Number(it.qty)||1)).toLocaleString();
      const del = document.createElement('button'); del.className='details-btn'; del.textContent='Убрать'; del.addEventListener('click', ()=> removeFromCart(it.id));
      row.append(name, price, del); list.appendChild(row);
    });
    const controls = document.createElement('div'); controls.className='cart-controls';
    const totalEl = document.createElement('div'); totalEl.className='cart-total'; totalEl.textContent = 'Итого: ' + total.toLocaleString() + ' кредитов';
    const checkout = document.createElement('button'); checkout.className='details-btn'; checkout.textContent='Оформить заказ'; checkout.addEventListener('click', ()=> placeOrder());
    controls.append(totalEl, checkout);
    host.append(list, controls);
  }
  function initShop() {
    const store = document.getElementById('shop-pane-store'); if (!store) return;
    store.querySelectorAll('.store-item').forEach(card => {
      const btn = card.querySelector('button'); if (!btn) return;
      btn.addEventListener('click', () => {
        const id = card.getAttribute('data-id') || ''; const name = card.getAttribute('data-name') || ''; const price = Number(card.getAttribute('data-price')||0);
        addToCart({ id, name, price });
      });
    });
  }
  async function placeOrder() {
    try {
      const tg = window.Telegram?.WebApp || null; const items = readCart(); if (!items.length) return;
      const fd = new FormData(); fd.append('initData', tg?.initData || ''); fd.append('items', JSON.stringify(items));
      const r = await fetch('/api/shop/order', { method: 'POST', body: fd }); const d = await r.json().catch(()=>({}));
      if (!r.ok) throw new Error(d?.error||'Ошибка заказа');
      writeCart([]); renderCart(); try { window.Telegram?.WebApp?.showAlert?.('Заказ оформлен'); } catch(_) {}
      try { renderMyOrders(); } catch(_) {}
    } catch(e) { try { window.Telegram?.WebApp?.showAlert?.('Не удалось оформить заказ'); } catch(_) {} }
  }
  async function renderMyOrders() {
    const host = document.getElementById('shop-pane-myorders'); if (!host) return; host.innerHTML = '<div style="padding:12px; color: var(--gray);">Загрузка...</div>';
    try {
      const tg = window.Telegram?.WebApp || null; const fd = new FormData(); fd.append('initData', tg?.initData || '');
      const r = await fetch('/api/shop/my-orders', { method: 'POST', body: fd }); const data = await r.json();
      host.innerHTML=''; const list = data?.orders || [];
      if (!list.length) { host.innerHTML = '<div style="padding:12px; color: var(--gray);">Заказов нет.</div>'; return; }
      const table = document.createElement('table'); table.className='league-table';
      const thead = document.createElement('thead'); thead.innerHTML = '<tr><th>№</th><th>Товары</th><th>Шт</th><th>Сумма</th><th>Создан</th><th>Статус</th></tr>';
      const tbody = document.createElement('tbody');
      list.forEach((o, i) => {
        const tr = document.createElement('tr');
        const sum = Number(o.total||0);
        const qty = Number(o.total_qty||0);
        const items = (o.items||[]).map(x=>x.name).join(', ');
        tr.innerHTML = `<td>${i+1}</td><td>${items}</td><td>${qty}</td><td>${sum.toLocaleString()}</td><td>${o.created_at||''}</td><td>${o.status||''}</td>`;
        tbody.appendChild(tr);
      });
      table.append(thead, tbody); host.appendChild(table);
    } catch(_) { host.innerHTML = '<div style="padding:12px; color: var(--gray);">Ошибка загрузки</div>'; }
  }
  function initShopUI() {
    const tabs = document.querySelectorAll('#shop-subtabs .subtab-item');
    const panes = { store: document.getElementById('shop-pane-store'), cart: document.getElementById('shop-pane-cart'), myorders: document.getElementById('shop-pane-myorders') };
    tabs.forEach(btn => {
      btn.setAttribute('data-throttle', '600');
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-stab');
        tabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
        if (panes[key]) panes[key].style.display = '';
        if (key === 'cart') renderCart();
        if (key === 'myorders') renderMyOrders();
      });
    });
    initShop(); updateCartBadge();
  }
  window.Shop = { initShopUI, updateCartBadge, readCart, writeCart, addToCart, removeFromCart, renderCart, initShop, placeOrder, renderMyOrders };
})();

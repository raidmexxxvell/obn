// shop.js — логика магазина и корзины

document.addEventListener('DOMContentLoaded', () => {
    // Инициализация вкладок
    setupTabs();
    
    // Инициализация товаров
    setupProducts();
    
    // Инициализация корзины
    setupCart();
    
    // Загрузка корзины
    loadCart();
});

function setupTabs() {
    const tabs = document.querySelectorAll('.shop-tab');
    const tabContents = document.querySelectorAll('.shop-tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Удаляем активный класс со всех вкладок
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // Добавляем активный класс текущей вкладке
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            document.querySelector(`.shop-tab-content[data-tab-content="${tabName}"]`).classList.add('active');
            
            // Если переключаемся на корзину, загружаем ее содержимое
            if (tabName === 'cart') {
                loadCart();
            }
        });
    });
}

function setupProducts() {
    document.querySelectorAll('.add-to-cart-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const productId = btn.dataset.productId;
            const quantity = 1; // По умолчанию добавляем 1 товар
            
            try {
                const response = await fetch('/miniapp/add_to_cart', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        product_id: productId,
                        quantity: quantity
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showNotification('Товар добавлен в корзину', 'success');
                    
                    // Обновляем корзину
                    loadCart();
                } else {
                    showNotification(data.error || 'Ошибка при добавлении товара', 'error');
                }
            } catch (error) {
                console.error('Error adding to cart:', error);
                showNotification('Произошла ошибка. Попробуйте позже.', 'error');
            }
        });
    });
}

function setupCart() {
    // Обработчик изменения количества
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('quantity-btn')) {
            const itemId = e.target.closest('.cart-item').dataset.itemId;
            const isPlus = e.target.classList.contains('plus');
            
            updateCartItemQuantity(itemId, isPlus ? 1 : -1);
        }
        
        if (e.target.classList.contains('remove-item-btn')) {
            const itemId = e.target.closest('.cart-item').dataset.itemId;
            removeCartItem(itemId);
        }
    });
    
    // Обработчик оформления заказа
    const checkoutBtn = document.getElementById('checkout-btn');
    if (checkoutBtn) {
        checkoutBtn.addEventListener('click', processCheckout);
    }
}

function loadCart() {
    const container = document.getElementById('cart-items');
    if (!container) return;
    
    container.innerHTML = '<div class="loader"></div>';
    
    fetch('/miniapp/cart')
        .then(response => response.json())
        .then(data => {
            if (data.cart_items.length === 0) {
                container.innerHTML = `
                    <p class="empty-cart">Ваша корзина пуста</p>
                    <a href="/miniapp/shop" class="btn continue-shopping">Продолжить покупки</a>
                `;
                return;
            }
            
            let html = `
                <div class="cart-items-list">
                    ${data.cart_items.map(item => `
                        <div class="cart-item" data-item-id="${item.id}">
                            <div class="cart-item-image">
                                <img src="/static/images/shop/${item.image}" alt="${item.name}">
                            </div>
                            <div class="cart-item-info">
                                <h3>${item.name}</h3>
                                <p class="item-price">${item.price} кредитов</p>
                                <div class="item-quantity">
                                    <button class="quantity-btn minus">-</button>
                                    <span class="quantity-value">${item.quantity}</span>
                                    <button class="quantity-btn plus">+</button>
                                </div>
                            </div>
                            <div class="item-total">
                                ${item.total} кредитов
                            </div>
                            <button class="remove-item-btn">×</button>
                        </div>
                    `).join('')}
                </div>
                
                <div class="cart-summary">
                    <div class="summary-row">
                        <span>Итого:</span>
                        <span class="total-amount">${data.total} кредитов</span>
                    </div>
                    <div class="summary-row">
                        <span>Ваш баланс:</span>
                        <span class="user-balance">${data.user.coins} кредитов</span>
                    </div>
                    <div class="summary-row total">
                        <span>К оплате:</span>
                        <span class="total-amount">${data.total} кредитов</span>
                    </div>
                    
                    ${data.user.coins >= data.total ? 
                        '<button id="checkout-btn" class="btn checkout-btn">Оформить заказ</button>' : 
                        '<button class="btn checkout-btn disabled">Недостаточно кредитов</button>'
                    }
                </div>
            `;
            
            container.innerHTML = html;
            
            // Повторно инициализируем обработчики корзины
            setupCart();
        })
        .catch(error => {
            console.error('Error loading cart:', error);
            container.innerHTML = '<p class="error">Ошибка загрузки корзины</p>';
        });
}

function updateCartItemQuantity(itemId, change) {
    fetch(`/miniapp/update_cart`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            item_id: itemId,
            change: change
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            loadCart();
        } else {
            showNotification(data.error || 'Ошибка при обновлении количества', 'error');
        }
    })
    .catch(error => {
        console.error('Error updating cart:', error);
        showNotification('Произошла ошибка. Попробуйте позже.', 'error');
    });
}

function removeCartItem(itemId) {
    fetch('/miniapp/remove_from_cart', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            product_id: itemId
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('Товар удален из корзины', 'success');
            loadCart();
        } else {
            showNotification(data.error || 'Ошибка при удалении товара', 'error');
        }
    })
    .catch(error => {
        console.error('Error removing item from cart:', error);
        showNotification('Произошла ошибка. Попробуйте позже.', 'error');
    });
}

function processCheckout() {
    if (document.querySelector('.checkout-btn.disabled')) {
        return;
    }
    
    if (confirm('Вы уверены, что хотите оформить заказ?')) {
        fetch('/miniapp/checkout', {
            method: 'POST'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showNotification('Заказ оформлен! С вами свяжется администратор.', 'success');
                setTimeout(() => {
                    // Переключаемся на страницу магазина
                    document.querySelector('.shop-tab[data-tab="products"]').click();
                }, 2000);
            } else {
                showNotification(data.error || 'Ошибка при оформлении заказа', 'error');
            }
        })
        .catch(error => {
            console.error('Error processing checkout:', error);
            showNotification('Произошла ошибка. Попробуйте позже.', 'error');
        });
    }
}

function showNotification(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type} show`;
    toast.innerHTML = `
        <div class="toast-content">
            <span class="toast-message">${message}</span>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 3000);
}
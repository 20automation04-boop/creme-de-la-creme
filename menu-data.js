// menu-data.js
// Single source of truth for the menu's STARTING state. Both index.js and
// seed-availability.js require this file, so the menu only ever lives in
// one place — edit it here and both stay in sync automatically.
//
// At runtime the Availability sheet layers on top of this: it can mark items
// sold out, override prices, rename items, add new ones, and discontinue
// them without a deploy (see applyMenuSheetRows in index.js). So this file
// is the baseline, not necessarily what customers see right now.
//
// Items with a `sizes` array offer Regular/Large; items with a flat `price` don't.

module.exports = [
  { id: '1', category: 'Frozen Drinks – $7', items: [
    { name: 'Vanilla Bean', price: 7 },
    { name: 'Coffee', price: 7 },
    { name: 'Chocolate', price: 7 },
    { name: 'Strawberry', price: 7 },
    { name: 'Piña Colada', price: 7 },
    { name: 'Blue Bubblegum', price: 7 },
    { name: 'Peanut', price: 7 },
    { name: 'Chocolate Chip & Mint', price: 7 },
    { name: 'Oreo Cookie', price: 7 },
  ]},
  { id: '2', category: 'Our Favs – $9', items: [
    { name: 'Salt Caramel Coffee', price: 9 },
    { name: 'French Vanilla Coffee', price: 9 },
    { name: 'Mochaccino', price: 9 },
    { name: 'Strawberry Cheesecake', price: 9 },
    { name: 'Oreo Cheesecake', price: 9 },
    { name: "Snickers n' Cream", price: 9 },
    { name: 'Brownie Blizzard', price: 9 },
    { name: "Berries n' Cream", price: 9 },
    { name: 'Very Berry', price: 9 },
    { name: 'Summer Blast', price: 9 },
  ]},
  { id: '3', category: 'Chamoyadas – $9', items: [
    { name: 'Mango/Pine', price: 9 },
    { name: 'Mango', price: 9 },
    { name: 'Strawberry', price: 9 },
    { name: 'Pineapple', price: 9 },
    { name: 'Green Apple', price: 9 },
  ]},
  { id: '4', category: 'Classic Cafe Latte – $7', items: [
    { name: 'Americano', price: 7 },
    { name: 'French Vanilla', price: 7 },
    { name: 'Caramel', price: 7 },
    { name: 'Mochaccino', price: 7 },
  ]},
  { id: '5', category: 'Iced Tea Refresher – $5', items: [
    { name: 'Mango Tango', price: 5 },
    { name: 'Mix Fruit', price: 5 },
    { name: 'Kiwi', price: 5 },
    { name: 'Strawberry', price: 5 },
    { name: 'Honey & Lemon', price: 5 },
  ]},
  { id: '6', category: 'Fruity Smoothie', items: [
    { name: 'Papaya', sizes: [{ key: '1', label: 'Regular', price: 6 }, { key: '2', label: 'Large', price: 8 }] },
    { name: 'Banana', sizes: [{ key: '1', label: 'Regular', price: 6 }, { key: '2', label: 'Large', price: 8 }] },
    { name: 'Raspberry', sizes: [{ key: '1', label: 'Regular', price: 6 }, { key: '2', label: 'Large', price: 8 }] },
    { name: 'Blackberry', sizes: [{ key: '1', label: 'Regular', price: 6 }, { key: '2', label: 'Large', price: 8 }] },
    { name: 'Blueberry', sizes: [{ key: '1', label: 'Regular', price: 6 }, { key: '2', label: 'Large', price: 8 }] },
    { name: 'Pineapple', sizes: [{ key: '1', label: 'Regular', price: 6 }, { key: '2', label: 'Large', price: 8 }] },
    { name: 'Strawberry', sizes: [{ key: '1', label: 'Regular', price: 6 }, { key: '2', label: 'Large', price: 8 }] },
  ]},
  { id: '7', category: 'Bubble Milk Tea – $6', items: [
    { name: 'Bubble Milk Tea', price: 6 },
  ]},
  { id: '8', category: 'Subs & Sandwiches', items: [
    { name: 'Grilled Cheese', price: 4 },
    { name: 'Grilled Ham & Cheese', price: 8 },
    { name: 'Chicken & Cheese Sub', price: 10 },
    { name: 'Pulled Pork & Cheese Sub', price: 10 },
    { name: 'Steak & Cheese Sub', price: 12 },
  ]},
  { id: '9', category: 'Dip & Chips', items: [
    { name: 'Homemade Cheese Dip', price: 5 },
    { name: 'Ground Steak & Homemade Dip', price: 8.5 },
    { name: 'Chicken Dip', price: 8.5 },
    { name: 'Chipotle Sausage Dip', price: 8.5 },
  ]},
  { id: '10', category: 'Quesadillas', items: [
    { name: 'Cheese & Cheese', price: 10 },
    { name: 'Veggie & Cheese', price: 10 },
    { name: 'Chicken & Cheese', price: 12 },
    { name: 'Pork & Cheese', price: 12 },
    { name: 'Ground Steak & Cheese', price: 12 },
  ]},
  { id: '11', category: 'Street Favorites', items: [
    { name: 'Hot Dog', price: 2.5 },
    { name: 'Chili Dog', price: 3.75 },
    { name: 'Cheesy Birria Tacos - Chicken', price: 10 },
    { name: 'Cheesy Birria Tacos - Ground Steak', price: 10 },
    { name: 'Cheesy Birria Tacos - Pork', price: 12 },
  ]},
];
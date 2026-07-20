/* Lubayd SA - Firebase Authentication, Cloud Firestore and internal chat */
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyCQDwcbAox4QEDe_czZX_YSd9jVx9g5BkY",
    authDomain: "lubayd-sa.firebaseapp.com",
    projectId: "lubayd-sa",
    storageBucket: "lubayd-sa.firebasestorage.app",
    messagingSenderId: "916029913982",
    appId: "1:916029913982:web:cc4e5b02b8b8055171d12f",
    measurementId: "G-LVP0TWS84N"
  };

  function normalizeFirestoreValue(value) {
    if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
    if (Array.isArray(value)) return value.map(normalizeFirestoreValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(function (entry) {
        return [entry[0], normalizeFirestoreValue(entry[1])];
      }));
    }
    return value;
  }

  function authErrorMessage(error) {
    const messages = {
      'auth/invalid-email': 'El correo electrónico no es válido.',
      'auth/missing-password': 'Ingresa la contraseña.',
      'auth/invalid-credential': 'Correo o contraseña incorrectos.',
      'auth/user-not-found': 'No existe una cuenta con ese correo.',
      'auth/wrong-password': 'La contraseña es incorrecta.',
      'auth/email-already-in-use': 'Ya existe una cuenta con ese correo.',
      'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
      'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
      'auth/network-request-failed': 'No se pudo conectar con Firebase. Revisa internet.',
      'auth/operation-not-allowed': 'Debes habilitar el acceso por correo y contraseña en Firebase Authentication.',
      'permission-denied': 'Firebase rechazó la operación. Publica las reglas incluidas en esta versión.'
    };
    return messages[error && error.code] || (error && error.message) || 'No se pudo completar la operación.';
  }

  function safeName(profile, user) {
    return String(profile?.nombre || user?.displayName || user?.email || 'Usuario').trim();
  }

  try {
    if (!window.firebase) throw new Error('Firebase SDK no disponible');
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const auth = firebase.auth();
    const db = firebase.firestore();
    const FieldValue = firebase.firestore.FieldValue;
    const serverTimestamp = FieldValue.serverTimestamp;

    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function (error) {
      console.warn('Persistencia de sesión:', error);
    });

    db.enablePersistence({ synchronizeTabs: true }).catch(function (error) {
      if (error.code !== 'failed-precondition' && error.code !== 'unimplemented') {
        console.warn('Persistencia Firestore:', error);
      }
    });

    const partesCollection = db.collection('partes');
    const usersCollection = db.collection('usuarios');
    const chatsCollection = db.collection('chats');

    window.LubaydAuth = {
      available: true,
      currentUser() {
        return auth.currentUser;
      },
      currentProfile() {
        return window.LubaydCurrentProfile || null;
      },
      async login(email, password) {
        const credential = await auth.signInWithEmailAndPassword(String(email || '').trim(), password);
        return credential.user;
      },
      async register(name, email, password) {
        window.LubaydRegistrationInProgress = true;
        try {
          const credential = await auth.createUserWithEmailAndPassword(String(email || '').trim(), password);
          const cleanName = String(name || '').trim();
          if (cleanName) await credential.user.updateProfile({ displayName: cleanName });
          await usersCollection.doc(credential.user.uid).set({
            nombre: cleanName || credential.user.email || 'Usuario',
            email: credential.user.email || '',
            active: true,
            role: 'operador',
            createdAt: serverTimestamp()
          });
          await credential.user.reload();
          window.LubaydCurrentUser = auth.currentUser;
          return auth.currentUser;
        } finally {
          window.LubaydRegistrationInProgress = false;
          window.dispatchEvent(new CustomEvent('lubayd-auth-changed', { detail: { user: auth.currentUser } }));
        }
      },
      async getProfile(user) {
        if (!user) return null;
        const reference = usersCollection.doc(user.uid);
        let snapshot = await reference.get();
        if (!snapshot.exists) {
          await reference.set({
            nombre: user.displayName || user.email || 'Usuario',
            email: user.email || '',
            active: true,
            role: 'operador',
            createdAt: serverTimestamp()
          });
          snapshot = await reference.get();
        }
        return Object.assign({ uid: user.uid }, normalizeFirestoreValue(snapshot.data() || {}));
      },
      async resetPassword(email) {
        return auth.sendPasswordResetEmail(String(email || '').trim());
      },
      async logout() {
        return auth.signOut();
      },
      errorMessage: authErrorMessage
    };

    window.LubaydCloud = {
      available: true,
      subscribe(onData, onError) {
        if (!auth.currentUser) throw new Error('Debes iniciar sesión para sincronizar.');
        return partesCollection.onSnapshot({ includeMetadataChanges: true }, function (snapshot) {
          const records = snapshot.docs.map(function (doc) {
            return Object.assign({ id: doc.id }, normalizeFirestoreValue(doc.data()));
          }).sort(function (a, b) {
            return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
          });
          onData(records, {
            fromCache: snapshot.metadata.fromCache,
            hasPendingWrites: snapshot.metadata.hasPendingWrites
          });
        }, onError);
      },
      save(record) {
        const user = auth.currentUser;
        if (!user) return Promise.reject(new Error('Debes iniciar sesión.'));
        if (!record || !record.gps) return Promise.reject(new Error('El parte requiere ubicación GPS.'));

        const payload = Object.assign({}, record, {
          createdByUid: user.uid,
          createdByEmail: user.email || '',
          createdByName: user.displayName || user.email || 'Usuario',
          createdAtServer: serverTimestamp(),
          gps: Object.assign({}, record.gps, {
            capturedAtServer: serverTimestamp()
          })
        });

        return partesCollection.doc(record.id).set(payload);
      },
      remove(id) {
        if (!auth.currentUser) return Promise.reject(new Error('Debes iniciar sesión.'));
        return partesCollection.doc(id).delete();
      }
    };

    window.LubaydChat = {
      available: true,
      subscribeUsers(profile, onData, onError) {
        if (!auth.currentUser) throw new Error('Debes iniciar sesión.');
        const query = profile?.role === 'admin'
          ? usersCollection
          : usersCollection.where('role', '==', 'admin');
        return query.onSnapshot(function (snapshot) {
          const users = snapshot.docs.map(function (doc) {
            return Object.assign({ uid: doc.id }, normalizeFirestoreValue(doc.data()));
          }).filter(function (user) {
            return user.active === true && user.uid !== auth.currentUser.uid;
          }).sort(function (a, b) {
            return String(a.nombre || a.email || '').localeCompare(String(b.nombre || b.email || ''), 'es');
          });
          onData(users);
        }, onError);
      },
      subscribeConversations(onData, onError) {
        if (!auth.currentUser) throw new Error('Debes iniciar sesión.');
        return chatsCollection.where('participants', 'array-contains', auth.currentUser.uid)
          .onSnapshot(function (snapshot) {
            const conversations = snapshot.docs.map(function (doc) {
              return Object.assign({ id: doc.id }, normalizeFirestoreValue(doc.data()));
            }).sort(function (a, b) {
              return String(b.lastMessageAtClient || b.createdAtClient || '')
                .localeCompare(String(a.lastMessageAtClient || a.createdAtClient || ''));
            });
            onData(conversations);
          }, onError);
      },
      async ensureConversation(peer, profile) {
        const user = auth.currentUser;
        if (!user || !peer || !profile) throw new Error('No se pudo identificar a los participantes.');

        const currentIsAdmin = profile.role === 'admin';
        const admin = currentIsAdmin
          ? { uid: user.uid, nombre: safeName(profile, user), email: user.email || '', role: 'admin' }
          : peer;
        const operator = currentIsAdmin
          ? peer
          : { uid: user.uid, nombre: safeName(profile, user), email: user.email || '', role: profile.role || 'operador' };

        if (admin.role !== 'admin') throw new Error('No hay un administrador configurado para el chat.');
        if (admin.uid === operator.uid) throw new Error('No puedes iniciar una conversación contigo mismo.');

        const id = [admin.uid, operator.uid].sort().join('__');
        const reference = chatsCollection.doc(id);
        const snapshot = await reference.get();
        const now = new Date().toISOString();

        if (!snapshot.exists) {
          await reference.set({
            participants: [admin.uid, operator.uid],
            adminUid: admin.uid,
            adminName: admin.nombre || admin.email || 'Administrador',
            adminEmail: admin.email || '',
            operatorUid: operator.uid,
            operatorName: operator.nombre || operator.email || 'Operador',
            operatorEmail: operator.email || '',
            lastMessage: '',
            lastMessageAt: serverTimestamp(),
            lastMessageAtClient: now,
            lastSenderId: '',
            unreadByAdmin: 0,
            unreadByOperator: 0,
            createdAt: serverTimestamp(),
            createdAtClient: now
          });
        }

        const latest = await reference.get();
        return Object.assign({ id }, normalizeFirestoreValue(latest.data() || {}));
      },
      subscribeMessages(chatId, onData, onError) {
        if (!auth.currentUser || !chatId) throw new Error('Conversación no disponible.');
        return chatsCollection.doc(chatId).collection('mensajes')
          .orderBy('createdAtClient', 'asc')
          .onSnapshot(function (snapshot) {
            const messages = snapshot.docs.map(function (doc) {
              return Object.assign({ id: doc.id }, normalizeFirestoreValue(doc.data()));
            });
            onData(messages);
          }, onError);
      },
      async sendMessage(chatId, text) {
        const user = auth.currentUser;
        const cleanText = String(text || '').trim();
        if (!user) throw new Error('Debes iniciar sesión.');
        if (!chatId) throw new Error('Selecciona una conversación.');
        if (!cleanText) throw new Error('Escribe un mensaje.');
        if (cleanText.length > 1000) throw new Error('El mensaje supera los 1000 caracteres.');

        const chatRef = chatsCollection.doc(chatId);
        const chatSnapshot = await chatRef.get();
        if (!chatSnapshot.exists) throw new Error('La conversación no existe.');
        const chat = chatSnapshot.data();
        if (!Array.isArray(chat.participants) || !chat.participants.includes(user.uid)) {
          throw new Error('No tienes acceso a esta conversación.');
        }

        const receiverId = chat.participants.find(function (uid) { return uid !== user.uid; });
        const ownIsAdmin = chat.adminUid === user.uid;
        const now = new Date().toISOString();
        const messageRef = chatRef.collection('mensajes').doc();
        const batch = db.batch();

        batch.set(messageRef, {
          text: cleanText,
          senderId: user.uid,
          receiverId: receiverId,
          createdAt: serverTimestamp(),
          createdAtClient: now
        });

        const chatUpdate = {
          lastMessage: cleanText.slice(0, 160),
          lastMessageAt: serverTimestamp(),
          lastMessageAtClient: now,
          lastSenderId: user.uid
        };
        if (ownIsAdmin) {
          chatUpdate.unreadByAdmin = 0;
          chatUpdate.unreadByOperator = FieldValue.increment(1);
        } else {
          chatUpdate.unreadByOperator = 0;
          chatUpdate.unreadByAdmin = FieldValue.increment(1);
        }
        batch.set(chatRef, chatUpdate, { merge: true });
        await batch.commit();
      },
      async markRead(chatId) {
        const user = auth.currentUser;
        if (!user || !chatId) return;
        const reference = chatsCollection.doc(chatId);
        const snapshot = await reference.get();
        if (!snapshot.exists) return;
        const chat = snapshot.data();
        if (!Array.isArray(chat.participants) || !chat.participants.includes(user.uid)) return;
        const field = chat.adminUid === user.uid ? 'unreadByAdmin' : 'unreadByOperator';
        if (Number(chat[field] || 0) > 0) await reference.set({ [field]: 0 }, { merge: true });
      }
    };

    auth.onAuthStateChanged(function (user) {
      window.LubaydCurrentUser = user || null;
      if (!user) window.LubaydCurrentProfile = null;
      if (window.LubaydRegistrationInProgress) return;
      window.dispatchEvent(new CustomEvent('lubayd-auth-changed', { detail: { user: user || null } }));
    });

    window.dispatchEvent(new CustomEvent('lubayd-firebase-ready'));
  } catch (error) {
    console.error('Firebase:', error);
    window.LubaydAuth = { available: false, error: error, errorMessage: authErrorMessage };
    window.LubaydCloud = { available: false, error: error };
    window.LubaydChat = { available: false, error: error };
    window.dispatchEvent(new CustomEvent('lubayd-firebase-error', { detail: error }));
  }
})();

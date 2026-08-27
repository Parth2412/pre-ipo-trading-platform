import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { ConflictException, ErrorCode } from '../common/errors';
import { parseCash } from '../common/money';
import { DatabaseService } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuthTokenDto, LoginDto, RegisterDto } from './dto/auth.dto';
import { AuthenticatedUser, JwtPayload } from './auth.types';

const BCRYPT_ROUNDS = 10;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: 'USER' | 'ADMIN';
}

/**
 * Deliberately small authentication layer: email + password, a signed JWT, and
 * a role claim. No refresh tokens, no session store, no password reset — the
 * brief calls for lightweight auth, and every hour spent here is an hour not
 * spent on the ledger.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthTokenDto> {
    const passwordHash = await hash(dto.password, BCRYPT_ROUNDS);
    const displayName = dto.displayName?.trim() || dto.email.split('@')[0];
    const bonus = parseCash(String(this.config.auth.signupBonusUsd));

    const user = await this.database.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO users (email, password_hash, display_name)
        VALUES (${dto.email}::text, ${passwordHash}::text, ${displayName}::text)
        ON CONFLICT (lower(email)) DO NOTHING
        RETURNING id, email, password_hash, display_name, role
      `);
      const row = inserted.rows[0] as unknown as UserRow | undefined;
      if (!row) {
        throw new ConflictException(
          ErrorCode.EMAIL_ALREADY_REGISTERED,
          'An account already exists for that email address.',
          { email: dto.email },
        );
      }

      if (bonus > 0n) {
        await this.ledger.deposit(tx, row.id, bonus, 'Welcome stablecoin balance', 'SIGNUP');
      }
      return row;
    });

    return this.issueToken(user);
  }

  async login(dto: LoginDto): Promise<AuthTokenDto> {
    const result = await this.database.db.execute(sql`
      SELECT id, email, password_hash, display_name, role
      FROM users
      WHERE lower(email) = lower(${dto.email}::text)
    `);
    const user = result.rows[0] as unknown as UserRow | undefined;

    // Always run a comparison so a missing account and a wrong password take a
    // similar amount of time.
    const passwordMatches = await compare(
      dto.password,
      user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidix',
    );
    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    return this.issueToken(user);
  }

  async findById(userId: string): Promise<AuthenticatedUser | undefined> {
    const result = await this.database.db.execute(sql`
      SELECT id, email, role FROM users WHERE id = ${userId}::uuid
    `);
    const row = result.rows[0] as unknown as Pick<UserRow, 'id' | 'email' | 'role'> | undefined;
    return row ? { id: row.id, email: row.email, role: row.role } : undefined;
  }

  verify(token: string): JwtPayload {
    return this.jwt.verify<JwtPayload>(token, { secret: this.config.auth.jwtSecret });
  }

  private issueToken(user: UserRow): AuthTokenDto {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return {
      accessToken: this.jwt.sign(payload),
      expiresIn: this.config.auth.jwtExpiresIn,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
      },
    };
  }
}
